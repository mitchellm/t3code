import {
  CommandId,
  type Ledger,
  LedgerId,
  type LedgerItemId,
  type LedgerMcpAddItemsInput,
  type LedgerMcpCreateInput,
  type LedgerMcpReadResult,
  type LedgerMcpRetryInput,
  type LedgerMcpSetCheckpointInput,
  type LedgerMcpUpdateItemInput,
  type LedgerMcpWriteResult,
  OrchestratorMcpFailure,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  investigationSpawnGuard,
  investigationSpawnRefusal,
} from "../orchestration-v2/Investigation.ts";
import * as LedgerJudgeRunner from "../orchestration-v2/LedgerJudgeRunner.ts";
import { latestUserMessageAt } from "./InvestigationSpawnGuard.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { requireThreadScope, type McpInvocationScope } from "./McpInvocationContext.ts";
import { ledgerLinksTasks, snapshotLedger } from "./ledgerSnapshot.ts";
import { dispatchFailure, unavailable } from "./threadAccess.ts";

export type LedgerMcpOperation =
  | "create"
  | "add-items"
  | "update-item"
  | "set-checkpoint"
  | "close"
  | "reopen";

/**
 * Every operation acts on the calling thread's own ledger. None takes a thread id, so an agent
 * cannot reach another thread's ledger however it fills in the arguments.
 */
export class LedgerMcpService extends Context.Service<
  LedgerMcpService,
  {
    readonly create: (
      scope: McpInvocationScope,
      input: LedgerMcpCreateInput,
    ) => Effect.Effect<LedgerMcpWriteResult, OrchestratorMcpFailure>;
    readonly addItems: (
      scope: McpInvocationScope,
      input: LedgerMcpAddItemsInput,
    ) => Effect.Effect<LedgerMcpWriteResult, OrchestratorMcpFailure>;
    readonly updateItem: (
      scope: McpInvocationScope,
      input: LedgerMcpUpdateItemInput,
    ) => Effect.Effect<LedgerMcpWriteResult, OrchestratorMcpFailure>;
    readonly setCheckpoint: (
      scope: McpInvocationScope,
      input: LedgerMcpSetCheckpointInput,
    ) => Effect.Effect<LedgerMcpWriteResult, OrchestratorMcpFailure>;
    readonly close: (
      scope: McpInvocationScope,
      input: LedgerMcpRetryInput,
    ) => Effect.Effect<LedgerMcpWriteResult, OrchestratorMcpFailure>;
    readonly reopen: (
      scope: McpInvocationScope,
      input: LedgerMcpRetryInput,
    ) => Effect.Effect<LedgerMcpWriteResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
    ) => Effect.Effect<LedgerMcpReadResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/LedgerMcpService") {}

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const stablePart = (value: string) => encodeURIComponent(value);

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const noLedger = () =>
  failure("invalid_request", "This thread has no ledger. Create one with ledger_create first.");

// A rejection is stored against its command id, so a retry under the same key can never succeed.
const ledgerFailure = (error: Parameters<typeof dispatchFailure>[0]) =>
  error._tag === "OrchestratorCommandPreviouslyRejectedError"
    ? failure(
        "invalid_request",
        `This request was already rejected: ${Array.from(error.detail).slice(0, 500).join("")} Read the ledger with ledger_read, fix the call, and retry with a new clientRequestId.`,
      )
    : dispatchFailure(error);

// Object keys are sorted so the same arguments hash the same however the client ordered them.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const ledgerIdFor = (threadId: ThreadId, requestKey: string) =>
  LedgerId.make(`ledger:${stablePart(threadId)}:${stablePart(requestKey)}`);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hashKey = (parts: unknown) =>
    crypto.digest("SHA-256", new TextEncoder().encode(stableJson(parts))).pipe(
      Effect.map(
        (digest) =>
          `auto-${Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ),
      Effect.orDie,
    );
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const judgeRunner = yield* LedgerJudgeRunner.LedgerJudgeRunner;

  const loadOwnLedger = Effect.fn("LedgerMcpService.loadOwnLedger")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure("capability_denied", "This credential cannot control threads.");
    }
    const { thread } = yield* requireThreadScope(scope, "Ledger tools");
    const shell = yield* threads.getThreadShell(thread.threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", "The calling thread was not found.");
    }
    const records = yield* threads
      .getProjectThreadRecords({ projectId: shell.projectId, threadId: thread.threadId }, [
        "ledger",
      ])
      .pipe(Effect.mapError(unavailable));
    return { threadId: thread.threadId, projectId: shell.projectId, ledger: records.ledger };
  });

  // Fork: a linked task's status is read from the thread's tasks each time, never stored.
  const snapshotOf = Effect.fn("LedgerMcpService.snapshotOf")(function* (own: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly ledger: Ledger | undefined;
  }) {
    if (own.ledger === undefined) return null;
    if (!ledgerLinksTasks(own.ledger)) return snapshotLedger(own.ledger);
    const { subagents } = yield* threads
      .getProjectThreadRecords({ projectId: own.projectId, threadId: own.threadId }, ["subagents"])
      .pipe(Effect.mapError(unavailable));
    return snapshotLedger(own.ledger, subagents);
  });

  const read = Effect.fn("LedgerMcpService.read")(function* (scope: McpInvocationScope) {
    return { ledger: yield* snapshotOf(yield* loadOwnLedger(scope)) };
  });

  const write = Effect.fn("LedgerMcpService.write")(function* (
    scope: McpInvocationScope,
    operation: LedgerMcpOperation,
    clientRequestId: string | undefined,
    /** What an identical retry must hash the same on; the key defaults to a hash of it. */
    fingerprint: (ledger: Ledger | undefined) => unknown,
    build: (context: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly requestKey: string;
      readonly ledger: Ledger | undefined;
    }) => Effect.Effect<OrchestrationV2ServerCommand, OrchestratorMcpFailure>,
    /** Whether the ledger already shows the change this call asks for. */
    applied: (ledger: Ledger | undefined) => boolean,
  ) {
    const { threadId, ledger } = yield* loadOwnLedger(scope);
    const send = (requestKey: string) => {
      const commandId = CommandId.make(
        [
          "command",
          "mcp",
          stablePart(scope.requestNamespace),
          `ledger-${operation}`,
          stablePart(threadId),
          // Per ledger, so a reused key cannot replay a replaced ledger's receipt. A create
          // names none yet, and its retry already sees the one it made.
          stablePart(operation === "create" ? "new" : (ledger?.id ?? "none")),
          stablePart(requestKey),
        ].join(":"),
      );
      return build({ commandId, threadId, requestKey, ledger }).pipe(
        Effect.flatMap((command) => threads.dispatch(command)),
      );
    };
    const settle = Effect.fn("LedgerMcpService.settle")(function* (sequence: number) {
      const after = yield* loadOwnLedger(scope);
      return { sequence, ledger: yield* snapshotOf(after), applied: applied(after.ledger) };
    });
    const toToolError = Effect.mapError(
      (error: OrchestratorMcpFailure | Parameters<typeof ledgerFailure>[0]) =>
        isMcpFailure(error) ? error : ledgerFailure(error),
    );

    if (clientRequestId !== undefined) {
      const { sequence, ledger: snapshot } = yield* send(clientRequestId).pipe(
        Effect.flatMap(({ sequence }) => settle(sequence)),
        toToolError,
      );
      return { sequence, ledger: snapshot };
    }
    // The default key hashes the arguments, so a retried lost response replays its receipt. The
    // hash also matches a stale earlier call (close, reopen, close), so a rejected receipt, or one
    // replayed without the change showing, is sent again once under a fresh key.
    const fresh = Effect.map(crypto.randomUUIDv4(), (id) => `fresh-${id}`).pipe(Effect.orDie);
    const hashed = hashKey([operation, fingerprint(ledger)]).pipe(
      Effect.flatMap(send),
      Effect.catchTags({
        OrchestratorCommandPreviouslyRejectedError: () => Effect.flatMap(fresh, send),
      }),
      Effect.flatMap(({ sequence }) => settle(sequence)),
    );
    const settled = yield* hashed.pipe(
      Effect.filterOrElse(
        (first) => first.applied,
        () => Effect.flatMap(fresh, send).pipe(Effect.flatMap(({ sequence }) => settle(sequence))),
      ),
      toToolError,
    );
    return { sequence: settled.sequence, ledger: settled.ledger };
  });

  // Edits to an existing ledger name it by id, read from the projection so the agent never types one.
  const onExisting = <Input extends LedgerMcpRetryInput>(
    operation: LedgerMcpOperation,
    scope: McpInvocationScope,
    input: Input,
    command: (common: {
      commandId: CommandId;
      threadId: ThreadId;
      ledgerId: LedgerId;
    }) => OrchestrationV2ServerCommand,
    applied: (ledger: Ledger) => boolean,
  ) =>
    write(
      scope,
      operation,
      input.clientRequestId,
      (ledger) => [ledger?.id ?? "none", { ...input, clientRequestId: undefined }],
      ({ commandId, threadId, ledger }) =>
        ledger === undefined
          ? Effect.fail(noLedger())
          : Effect.succeed(command({ commandId, threadId, ledgerId: ledger.id })),
      (ledger) => ledger !== undefined && applied(ledger),
    );

  const create = Effect.fn("LedgerMcpService.create")(function* (
    scope: McpInvocationScope,
    input: LedgerMcpCreateInput,
  ) {
    const args = { ...input, clientRequestId: undefined };
    return yield* write(
      scope,
      "create",
      input.clientRequestId,
      // A retry sees the open ledger its first attempt made, so an open one hashes as "new". A
      // closed ledger being replaced joins the hash, or an identical replacement would replay the
      // first ledger's receipt and never be created.
      (ledger) => [ledger !== undefined && ledger.closedAt !== null ? ledger.id : "new", args],
      ({ commandId, threadId, requestKey, ledger }) =>
        Effect.gen(function* () {
          // Fork: Investigate mode's spawn rule. A new ledger would lift an ended investigation's
          // stop, so it waits for the user's next message (a /ledger request is one).
          const endedAt = ledger?.investigation?.endedAt ?? null;
          if (endedAt !== null) {
            const lock = investigationSpawnGuard(
              ledger,
              yield* latestUserMessageAt(threads, threadId, endedAt).pipe(
                Effect.mapError(unavailable),
              ),
            );
            const problem = investigationSpawnRefusal(lock, "ledger_create");
            if (problem !== undefined) return yield* failure("invalid_request", problem);
          }
          return {
            type: "ledger.create" as const,
            commandId,
            threadId,
            // Derived from the request key, so a replayed create names the same ledger.
            ledgerId: ledgerIdFor(threadId, requestKey),
            title: input.title,
            startState: input.startState ?? "",
            checkpoints: input.checkpoints ?? [],
            winConditions: input.winConditions ?? [],
            items: input.items,
            createdBy: "agent" as const,
          };
        }),
      (ledger) => ledger !== undefined && ledger.closedAt === null,
    );
  });

  const addItems = Effect.fn("LedgerMcpService.addItems")(function* (
    scope: McpInvocationScope,
    input: LedgerMcpAddItemsInput,
  ) {
    return yield* onExisting(
      "add-items",
      scope,
      input,
      (common) => ({ type: "ledger.item.add", ...common, items: input.items }),
      (ledger) => input.items.every((added) => ledger.items.some((item) => item.id === added.id)),
    );
  });

  /**
   * Fork: the judge delegates from the agent's run, live only now; the outbox start can queue for
   * minutes, and until a judge task exists the Stop hook nudges as if the items were stuck. The
   * start is idempotent, so the outbox rejoins this judge, or starts it if this one failed.
   */
  const startRequestedJudge = Effect.fn("LedgerMcpService.startRequestedJudge")(function* (
    scope: McpInvocationScope,
    itemId: LedgerItemId,
  ) {
    const { threadId, ledger } = yield* loadOwnLedger(scope);
    const item = ledger?.items.find(({ id }) => id === itemId);
    if (ledger === undefined || item?.judging !== true || item.judgeTaskId !== undefined) return;
    yield* judgeRunner.start({
      threadId,
      ledgerId: ledger.id,
      itemId: item.id,
      requestedAt: DateTime.formatIso(item.updatedAt),
    });
  });

  const updateItem = Effect.fn("LedgerMcpService.updateItem")(function* (
    scope: McpInvocationScope,
    input: LedgerMcpUpdateItemInput,
  ) {
    if (
      input.status === undefined &&
      input.evidence === undefined &&
      input.dropReason === undefined &&
      input.deferReason === undefined &&
      input.blockedBy === undefined &&
      input.parentItemId === undefined
    ) {
      return yield* failure(
        "invalid_request",
        "Pass status, evidence, a reason, blockedBy or parentItemId to update.",
      );
    }
    const written = yield* onExisting(
      "update-item",
      scope,
      input,
      (common) => ({
        type: "ledger.item.update",
        ...common,
        itemId: input.itemId,
        // Every ledger tool call is the agent's; the planner holds it to what the user may do.
        createdBy: "agent",
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        ...(input.dropReason === undefined ? {} : { dropReason: input.dropReason }),
        ...(input.deferReason === undefined ? {} : { deferReason: input.deferReason }),
        ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy }),
        ...(input.parentItemId === undefined ? {} : { parentItemId: input.parentItemId }),
      }),
      (ledger) => {
        const item = ledger.items.find(({ id }) => id === input.itemId);
        return (
          item !== undefined &&
          // On a judged ledger a close request lands as judging; that is the change applied.
          (input.status === undefined ||
            item.status === input.status ||
            (input.status === "closed" && item.judging === true)) &&
          (input.evidence === undefined || item.evidence === input.evidence) &&
          (input.dropReason === undefined || item.dropReason === input.dropReason) &&
          (input.deferReason === undefined || item.deferReason === input.deferReason) &&
          (input.blockedBy === undefined ||
            JSON.stringify(item.blockedBy ?? []) === JSON.stringify(input.blockedBy)) &&
          (input.parentItemId === undefined || (item.parentItemId ?? null) === input.parentItemId)
        );
      },
    );
    if (input.status !== undefined) {
      yield* startRequestedJudge(scope, input.itemId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("ledger judge start with the close failed; the outbox retries it", {
            itemId: input.itemId,
            cause,
          }),
        ),
      );
    }
    return written;
  });

  const setCheckpoint = Effect.fn("LedgerMcpService.setCheckpoint")(function* (
    scope: McpInvocationScope,
    input: LedgerMcpSetCheckpointInput,
  ) {
    return yield* onExisting(
      "set-checkpoint",
      scope,
      input,
      (common) => ({
        type: "ledger.checkpoint.set",
        ...common,
        checkpointId: input.checkpointId,
        reached: input.reached,
      }),
      (ledger) =>
        ledger.checkpoints.find(({ id }) => id === input.checkpointId)?.reached === input.reached,
    );
  });

  const close = Effect.fn("LedgerMcpService.close")(function* (
    scope: McpInvocationScope,
    input: LedgerMcpRetryInput,
  ) {
    return yield* onExisting(
      "close",
      scope,
      input,
      (common) => ({ type: "ledger.close", ...common, createdBy: "agent" }),
      (ledger) => ledger.closedAt !== null,
    );
  });

  const reopen = Effect.fn("LedgerMcpService.reopen")(function* (
    scope: McpInvocationScope,
    input: LedgerMcpRetryInput,
  ) {
    return yield* onExisting(
      "reopen",
      scope,
      input,
      (common) => ({ type: "ledger.reopen", ...common, createdBy: "agent" }),
      (ledger) => ledger.closedAt === null,
    );
  });

  return LedgerMcpService.of({ read, create, addItems, updateItem, setCheckpoint, close, reopen });
});

export const layer: Layer.Layer<
  LedgerMcpService,
  never,
  Crypto.Crypto | ThreadManagementService.ThreadManagementService
> = Layer.effect(LedgerMcpService, make);
