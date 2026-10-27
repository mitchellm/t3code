import {
  type CommandId,
  isOrchestrationV2WorkActive,
  type Ledger,
  type LedgerInvestigation,
  type LedgerItem,
  LedgerItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { isApproachItem, isLiveApproach } from "@t3tools/shared/investigation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { LedgerCommand, LedgerRejection, PlannedLedgerEvent } from "./TaskLedger.ts";

/**
 * Fork: Investigate mode's state machine, kept pure so every transition is tested without a
 * server. Approaches are sub-items of one Approaches item; the ledger's judge refutes each thesis
 * (a close request). The first passing verdict solves the investigation in the same transaction,
 * so no reactor can race it; budget and Stop end it through `ledger.investigation.end`.
 */

export type InvestigationCommand = Extract<
  LedgerCommand,
  {
    readonly type:
      | "ledger.investigation.start"
      | "ledger.investigation.end"
      | "ledger.investigation.spend";
  }
>;

export const isInvestigationCommand = (command: LedgerCommand): command is InvestigationCommand =>
  command.type === "ledger.investigation.start" ||
  command.type === "ledger.investigation.end" ||
  command.type === "ledger.investigation.spend";

export const APPROACHES_ITEM_ID = LedgerItemId.make("approaches");
const LEDGER_TITLE_MAX = 120;

const isUnfinished = (item: Pick<LedgerItem, "status">) =>
  item.status === "open" || item.status === "in_progress";

function ledgerTitle(goal: string): string {
  const firstLine = goal.split("\n")[0]!.trim();
  const title = firstLine.length > 0 ? firstLine : "Investigation";
  return title.length > LEDGER_TITLE_MAX ? `${title.slice(0, LEDGER_TITLE_MAX - 1)}…` : title;
}

/** Drops the judge bookkeeping when the server sets an item aside. */
function settled(item: LedgerItem): LedgerItem {
  const { judging: _judging, judgeTaskId: _task, ...rest } = item;
  return rest;
}

type EndOutcome =
  | { readonly status: "solved"; readonly solvedItem: LedgerItem }
  | { readonly status: "exhausted" | "stopped"; readonly reason: string };

/**
 * Everything unfinished is dropped with the reason, the Approaches item is closed by the winner
 * (or dropped), and the ledger closes, so the between-turn follow-up has nothing left to push.
 */
function endEvents(
  ledger: Ledger,
  investigation: LedgerInvestigation,
  outcome: EndOutcome,
  now: DateTime.Utc,
): ReadonlyArray<PlannedLedgerEvent> {
  const reason =
    outcome.status === "solved"
      ? `Approach ${outcome.solvedItem.id} (${outcome.solvedItem.title}) survived the refuter.`
      : outcome.reason;
  const dropReason =
    outcome.status === "solved" ? `Not needed: ${reason}` : `Investigation ended: ${reason}`;
  const updates: Array<PlannedLedgerEvent> = [];
  for (const item of ledger.items) {
    if (item.id === investigation.approachesItemId) {
      const next: LedgerItem =
        outcome.status === "solved"
          ? {
              ...settled(item),
              status: "closed",
              evidence: reason,
              dropReason: null,
              closedAt: now,
              updatedAt: now,
            }
          : { ...settled(item), status: "dropped", dropReason, closedAt: null, updatedAt: now };
      if (item.status !== next.status) {
        updates.push({
          type: "ledger.item.updated",
          payload: { ledgerId: ledger.id, item: next, updatedAt: now },
        });
      }
      continue;
    }
    if (!isUnfinished(item)) continue;
    updates.push({
      type: "ledger.item.updated",
      payload: {
        ledgerId: ledger.id,
        item: { ...settled(item), status: "dropped", dropReason, closedAt: null, updatedAt: now },
        updatedAt: now,
      },
    });
  }
  return [
    ...updates,
    {
      type: "ledger.investigation.updated",
      payload: {
        ledgerId: ledger.id,
        investigation: {
          ...investigation,
          status: outcome.status,
          endedAt: now,
          endReason: reason,
          ...(outcome.status === "solved" ? { solvedItemId: outcome.solvedItem.id } : {}),
        },
        updatedAt: now,
      },
    },
    ...(ledger.closedAt === null
      ? [
          {
            type: "ledger.closed" as const,
            payload: { ledgerId: ledger.id, closedAt: now, updatedAt: now },
          },
        ]
      : []),
  ];
}

export function planInvestigationCommand(input: {
  readonly command: InvestigationCommand;
  readonly ledger: Ledger | undefined;
  readonly now: DateTime.Utc;
  readonly requiresJudge: boolean;
}): Result.Result<ReadonlyArray<PlannedLedgerEvent>, LedgerRejection> {
  const { command, ledger, now } = input;
  if (command.type === "ledger.investigation.start") {
    // A retried start finds its own ledger already running.
    if (ledger?.id === command.ledgerId && ledger.investigation !== undefined) {
      return Result.succeed([]);
    }
    if (ledger !== undefined && ledger.closedAt === null) {
      return Result.fail(
        `Thread ${command.threadId} already has an open ledger (${ledger.id}). Close it before starting an investigation.`,
      );
    }
    if (!input.requiresJudge) {
      return Result.fail(
        "Investigate needs a loadout with a judge role on an enabled provider, which refutes each approach's thesis. Pick one in the composer's loadout picker.",
      );
    }
    return Result.succeed([
      {
        type: "ledger.created",
        payload: {
          id: command.ledgerId,
          threadId: command.threadId,
          title: ledgerTitle(command.goal),
          startState: "",
          checkpoints: [],
          winConditions: [command.solvedWhen],
          items: [
            {
              id: APPROACHES_ITEM_ID,
              title: "Approaches",
              acceptance:
                "One approach's thesis survives the refuter, judged against the user's criteria.",
              status: "in_progress",
              evidence: null,
              dropReason: null,
              verdict: null,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
            },
          ],
          requiresJudge: true,
          investigation: {
            goal: command.goal,
            solvedWhen: command.solvedWhen,
            budget: command.budget,
            parallelApproaches: command.parallelApproaches,
            status: "running",
            approachesItemId: APPROACHES_ITEM_ID,
            startedAt: now,
            endedAt: null,
          },
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        },
      },
    ]);
  }
  if (ledger === undefined || ledger.id !== command.ledgerId) {
    return Result.fail(`Thread ${command.threadId} has no ledger ${command.ledgerId}.`);
  }
  const investigation = ledger.investigation;
  if (investigation === undefined) {
    return Result.fail(`Ledger ${ledger.id} is not an investigation.`);
  }
  // A deadline, Stop or spend report that lands after the investigation ended changes nothing.
  if (investigation.status !== "running") return Result.succeed([]);
  if (command.type === "ledger.investigation.spend") {
    return Result.succeed(planInvestigationSpend(ledger, command, now));
  }
  return Result.succeed(
    endEvents(ledger, investigation, { status: command.status, reason: command.reason }, now),
  );
}

/**
 * What the investigation refuses on top of the ledger's own rules. Approaches never move in or out
 * of the Approaches item: a moved item could carry a verdict from the ordinary judge, or free or
 * take a slot past the parallel limit. New and revived approaches must fit the limit.
 */
export function investigationCommandProblem(
  command: LedgerCommand,
  ledger: Ledger | undefined,
): string | undefined {
  const investigation = ledger?.investigation;
  if (ledger === undefined || investigation === undefined) return undefined;
  const byAgent = "createdBy" in command && command.createdBy === "agent";
  const running = investigation.status === "running";
  // The investigation decides when its ledger ends; the agent cannot end, replace or revive it.
  if (byAgent && running && command.type === "ledger.close") {
    return "The investigation closes its own ledger when an approach passes the refuter or the budget runs out. Keep working the approaches, or ask the user to stop it.";
  }
  if (byAgent && running && command.type === "ledger.create") {
    return "An investigation is running on this thread. Work its approaches; a new ledger would replace it.";
  }
  if (byAgent && !running && command.type === "ledger.reopen") {
    return `This ledger's investigation has ended (${investigation.status}). Only the user can reopen it.`;
  }
  const live = () =>
    ledger.items.filter((item) => isApproachItem(investigation, item) && isLiveApproach(item))
      .length;
  const overCap = (adding: number) =>
    live() + adding > investigation.parallelApproaches
      ? `The investigation runs at most ${investigation.parallelApproaches} approaches at once; ${live()} are still being explored or judged. Add more once one is refuted.`
      : undefined;
  if (command.type === "ledger.item.add") {
    const added = command.items.filter(
      (draft) =>
        draft.parentItemId === investigation.approachesItemId && draft.deferReason === undefined,
    ).length;
    if (added === 0) return undefined;
    if (investigation.status !== "running") {
      return `The investigation has ended (${investigation.status}); it takes no new approaches.`;
    }
    return overCap(added);
  }
  if (command.type !== "ledger.item.update") return undefined;
  const item = ledger.items.find(({ id }) => id === command.itemId);
  if (item === undefined) return undefined;
  if (
    byAgent &&
    running &&
    item.id === investigation.approachesItemId &&
    command.status !== undefined &&
    command.status !== item.status
  ) {
    return `The server manages the ${investigation.approachesItemId} item; it closes when an approach passes the refuter.`;
  }
  if (command.parentItemId !== undefined) {
    if (item.id === investigation.approachesItemId) {
      return `The ${investigation.approachesItemId} item holds the investigation's approaches and cannot move.`;
    }
    const wasApproach = isApproachItem(investigation, item);
    const becomesApproach = command.parentItemId === investigation.approachesItemId;
    if (wasApproach !== becomesApproach) {
      return wasApproach
        ? `Item ${item.id} is an approach and cannot leave ${investigation.approachesItemId}.`
        : `Item ${item.id} cannot move under ${investigation.approachesItemId}. Add a new approach item instead, so the refuter judges it.`;
    }
  }
  // Reviving a finished approach takes a slot like adding one.
  const revives =
    isApproachItem(investigation, item) &&
    !isUnfinished(item) &&
    (command.status === "open" || command.status === "in_progress");
  return revives ? overCap(1) : undefined;
}

/**
 * Marks a verdict recorded on an approach as the refuter's, which judged it (the judge picks the
 * refuter prompt by the same test). Any marker the command carried is replaced, so only this
 * planner attests it.
 */
export function stampRefuterVerdict(
  command: LedgerCommand,
  ledger: Ledger | undefined,
  planned: ReadonlyArray<PlannedLedgerEvent>,
): ReadonlyArray<PlannedLedgerEvent> {
  if (command.type !== "ledger.item.verdict.record") return planned;
  const investigation = ledger?.investigation;
  const before = ledger?.items.find(({ id }) => id === command.itemId);
  const refuter =
    investigation !== undefined && before !== undefined && isApproachItem(investigation, before);
  return planned.map((event) => {
    if (event.type !== "ledger.item.updated" || event.payload.item.id !== command.itemId) {
      return event;
    }
    const verdict = event.payload.item.verdict;
    if (verdict === null) return event;
    const { refuter: _claimed, ...plain } = verdict;
    return {
      ...event,
      payload: {
        ...event.payload,
        item: { ...event.payload.item, verdict: refuter ? { ...plain, refuter: true } : plain },
      },
    };
  });
}

/** Server-only spend report: changes the record only when the figure or its certainty moved. */
export function planInvestigationSpend(
  ledger: Ledger | undefined,
  input: { readonly spentUsd: number; readonly costUnknown: boolean },
  now: DateTime.Utc,
): ReadonlyArray<PlannedLedgerEvent> {
  const investigation = ledger?.investigation;
  if (ledger === undefined || investigation?.status !== "running") return [];
  const spentUsd = Math.round(input.spentUsd * 100) / 100;
  if (
    investigation.spentUsd === spentUsd &&
    (investigation.costUnknown === true) === input.costUnknown
  ) {
    return [];
  }
  const { costUnknown: _old, ...rest } = investigation;
  return [
    {
      type: "ledger.investigation.updated",
      payload: {
        ledgerId: ledger.id,
        investigation: { ...rest, spentUsd, ...(input.costUnknown ? { costUnknown: true } : {}) },
        updatedAt: now,
      },
    },
  ];
}

/**
 * The events a command planned, plus the solve they cause: an approach closing on a refuter's
 * pass. A close carried by any other verdict does not count, whatever path brought it there.
 */
export function followInvestigation(
  ledger: Ledger | undefined,
  planned: ReadonlyArray<PlannedLedgerEvent>,
  now: DateTime.Utc,
): ReadonlyArray<PlannedLedgerEvent> {
  const investigation = ledger?.investigation;
  if (ledger === undefined || investigation?.status !== "running") return planned;
  const solvedItem = planned.flatMap((event) =>
    event.type === "ledger.item.updated" &&
    event.payload.item.status === "closed" &&
    event.payload.item.verdict?.outcome === "pass" &&
    event.payload.item.verdict.refuter === true &&
    isApproachItem(investigation, event.payload.item) &&
    ledger.items.find(({ id }) => id === event.payload.item.id)?.status !== "closed"
      ? [event.payload.item]
      : [],
  )[0];
  if (solvedItem === undefined) return planned;
  // The end reads only items, so the planned item changes are all it needs folded in.
  const changed = new Map<string, LedgerItem>();
  for (const event of planned) {
    if (event.type === "ledger.item.updated")
      changed.set(event.payload.item.id, event.payload.item);
    if (event.type === "ledger.item.added") {
      for (const item of event.payload.items) changed.set(item.id, item);
    }
  }
  const after: Ledger = {
    ...ledger,
    items: [
      ...ledger.items.map((item) => changed.get(item.id) ?? item),
      ...[...changed.values()].filter((item) => !ledger.items.some(({ id }) => id === item.id)),
    ],
  };
  return [...planned, ...endEvents(after, investigation, { status: "solved", solvedItem }, now)];
}

/** A thread's standing under Investigate mode, for every agent tool that can start or wake work. */
export type InvestigationSpawnLock =
  | { readonly state: "open" }
  | { readonly state: "running"; readonly investigation: LedgerInvestigation }
  | { readonly state: "ended"; readonly investigation: LedgerInvestigation };

/**
 * The one rule. Locked while an investigation runs, and after it ends until a person types a
 * message in a client (`isTypedByPerson`). Report, wake and scheduled turns never unlock it, and
 * neither does a reopened ledger.
 */
export function investigationSpawnGuard(
  ledger: Ledger | undefined,
  latestUserMessageAt: DateTime.Utc | null,
): InvestigationSpawnLock {
  const investigation = ledger?.investigation;
  if (investigation === undefined) return { state: "open" };
  if (investigation.status === "running") return { state: "running", investigation };
  const endedAt = investigation.endedAt;
  if (
    endedAt !== null &&
    latestUserMessageAt !== null &&
    DateTime.toEpochMillis(latestUserMessageAt) > DateTime.toEpochMillis(endedAt)
  ) {
    return { state: "open" };
  }
  return { state: "ended", investigation };
}

/**
 * A message a person typed in a client. A scheduled task or webhook run is stamped with its
 * `scheduledTaskId` but copies the task's own author and source, and a usage-limit resume is the
 * user's from the server, so only a client source without that stamp counts.
 */
export const isTypedByPerson = (
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "scheduledTaskId"
  >,
) =>
  message.createdBy === "user" &&
  (message.creationSource === "web" || message.creationSource === "mobile") &&
  message.scheduledTaskId === undefined;

/** The report turn InvestigationService asks for, the one automatic turn an ended one allows. */
export const isInvestigationReport = (message: {
  readonly notification?: { readonly source: { readonly kind: string } } | undefined;
}) => message.notification?.source.kind === "investigation_report";

/** The reads `latestPersonMessageAt` needs; the server's two thread readers both provide them. */
export interface PersonMessageReader<E> {
  readonly runs: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Pick<OrchestrationV2Run, "id" | "completedAt">>, E>;
  readonly userMessages: (
    threadId: ThreadId,
    runIds: ReadonlyArray<RunId>,
  ) => Effect.Effect<
    ReadonlyArray<
      Pick<
        OrchestrationV2ConversationMessage,
        "createdBy" | "creationSource" | "scheduledTaskId" | "createdAt"
      >
    >,
    E
  >;
}

/**
 * When a person last typed on the thread after `since`. Only runs still live at `since` or later
 * can hold a newer message, so just those runs' user messages are read.
 */
export const latestPersonMessageAt = Effect.fn("Investigation.latestPersonMessageAt")(function* <E>(
  reader: PersonMessageReader<E>,
  threadId: ThreadId,
  since: DateTime.Utc,
): Effect.fn.Return<DateTime.Utc | null, E> {
  const sinceMs = DateTime.toEpochMillis(since);
  const runIds = (yield* reader.runs(threadId))
    .filter((run) => run.completedAt === null || DateTime.toEpochMillis(run.completedAt) >= sinceMs)
    .map(({ id }) => id);
  if (runIds.length === 0) return null;
  let latest: DateTime.Utc | null = null;
  for (const message of yield* reader.userMessages(threadId, runIds)) {
    if (!isTypedByPerson(message)) continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(message.createdAt) > DateTime.toEpochMillis(latest)
    ) {
      latest = message.createdAt;
    }
  }
  return latest;
});

/**
 * The run chokepoint's decision: why a message must not start a run. Only an ended investigation
 * holds anything; a person's message and the report turn always pass.
 */
export function investigationRunHold(found: InvestigationCallerLock): string | undefined {
  if (found.lock.state !== "ended") return undefined;
  return `Automatic work was not started: ${endedText(found.lock.investigation)} Send a message to start new work here.`;
}

const endedText = (investigation: LedgerInvestigation) =>
  `This thread's investigation has ended (${investigation.status}${investigation.endReason === undefined ? "" : `: ${investigation.endReason}`}) and its workers were stopped.`;

/**
 * Why a work-starting tool other than `delegate_task` is refused anywhere in a locked tree. While
 * running, new work goes through `delegate_task`; after the end, nothing starts until a person
 * types. `ledger_create` is refused here only after the end: while running the planner refuses it.
 */
export function investigationSpawnRefusal(
  lock: InvestigationSpawnLock,
  tool: string,
): string | undefined {
  if (lock.state === "open") return undefined;
  if (lock.state === "running") {
    return tool === "ledger_create"
      ? undefined
      : `An investigation is running on this thread or the one that delegated to it. Start work with delegate_task, which the investigation counts and stops; ${tool} is refused until it ends.`;
  }
  return `${endedText(lock.investigation)} ${tool} is refused until the user sends a new message; write the report.`;
}

/**
 * Why `delegate_task` refuses a new worker. After the end, every worker is refused. While running,
 * the thread takes no more than its parallel limit of running children (only the server's own
 * judge tasks are exempt), and none under the judge role, which the server runs itself.
 */
export function investigationDelegationProblem(input: {
  readonly lock: InvestigationSpawnLock;
  readonly activeWorkers: number;
  readonly requestedRole?: string | undefined;
}): string | undefined {
  const { lock } = input;
  if (lock.state === "open") return undefined;
  if (lock.state === "ended") {
    return `${endedText(lock.investigation)} Do not start new ones; write the report, or wait for the user's next message.`;
  }
  if (input.requestedRole === "judge") {
    return "An investigation is running on this thread, and the server runs its judge itself. Delegate approach work under the worker role.";
  }
  if (input.activeWorkers >= lock.investigation.parallelApproaches) {
    return `The investigation runs at most ${lock.investigation.parallelApproaches} workers at once and ${input.activeWorkers} are running. Wait for one to finish before starting another.`;
  }
  return undefined;
}

/** How far up the subagent chain the check looks; deeper delegation trees are not expected. */
const MAX_INVESTIGATION_DEPTH = 8;

/** The records the walk reads per thread. */
export interface InvestigationChainRecords {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage">;
  readonly ledger?: Ledger | undefined;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "role" | "status"> & {
      readonly serverJudge?: true | undefined;
    }
  >;
}

/** The lock that applies to a caller, found by walking up its subagent chain. */
export interface InvestigationCallerLock {
  readonly lock: InvestigationSpawnLock;
  /** The lock is the caller's own thread's, not an ancestor's. */
  readonly atCaller: boolean;
  /** The caller's running children that count against its cap. */
  readonly activeWorkers: number;
}

/**
 * The first investigation lock up the caller's subagent chain: it locks the whole tree, so no
 * worker starts threads its stop, spend and lock would miss. Accepted for v1: a worker's own
 * `delegate_task` helpers are uncapped while it runs; as subagents they are still stopped and locked.
 */
export const findInvestigationLock = Effect.fn("Investigation.findLock")(function* <E>(
  callerThreadId: ThreadId,
  read: (threadId: ThreadId) => Effect.Effect<InvestigationChainRecords, E>,
  latestUserMessageAt: (
    threadId: ThreadId,
    since: DateTime.Utc,
  ) => Effect.Effect<DateTime.Utc | null, E>,
): Effect.fn.Return<InvestigationCallerLock, E> {
  let threadId: ThreadId | null = callerThreadId;
  let activeWorkers = 0;
  const visited = new Set<ThreadId>();
  while (threadId !== null && !visited.has(threadId) && visited.size < MAX_INVESTIGATION_DEPTH) {
    visited.add(threadId);
    const records: InvestigationChainRecords = yield* read(threadId);
    const atCaller = threadId === callerThreadId;
    if (atCaller) {
      activeWorkers = records.subagents.filter(
        (task) =>
          task.origin === "app_owned" &&
          // Only the server's own judge is exempt; a role the agent named is not. Clients may
          // set the marker too, which is accepted: a client acts for the user.
          task.serverJudge !== true &&
          isOrchestrationV2WorkActive(task.status),
      ).length;
    }
    const investigation = records.ledger?.investigation;
    const endedAt = investigation?.endedAt ?? null;
    const lock = investigationSpawnGuard(
      records.ledger,
      endedAt === null ? null : yield* latestUserMessageAt(threadId, endedAt),
    );
    if (lock.state !== "open") return { lock, atCaller, activeWorkers };
    threadId =
      records.thread.lineage.relationshipToParent === "subagent"
        ? records.thread.lineage.parentThreadId
        : null;
  }
  return { lock: { state: "open" }, atCaller: true, activeWorkers };
});

/** A spawn tool's refusal for the caller: any lock in its tree applies, its own or an ancestor's. */
export const spawnRefusalFor = (found: InvestigationCallerLock, tool: string) =>
  investigationSpawnRefusal(found.lock, tool);

/**
 * `delegate_task`'s refusal for the caller. Only the investigation thread itself is capped; a
 * worker may start helpers while it runs, but nobody in the tree may once it has ended.
 */
export const delegationRefusalFor = (
  found: InvestigationCallerLock,
  requestedRole: string | undefined,
) =>
  found.lock.state === "running" && !found.atCaller
    ? undefined
    : investigationDelegationProblem({
        lock: found.lock,
        activeWorkers: found.atCaller ? found.activeWorkers : 0,
        requestedRole,
      });

const delegationLeases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/**
 * Runs one delegation's cap check and dispatch alone per parent thread, so two concurrent
 * `delegate_task` calls cannot both pass the cap before either task is recorded. Keyed like
 * `withWorkspaceLease`, and dropped once nobody holds or waits for it.
 */
export const withInvestigationDelegationLease = <A, E, R>(
  threadId: ThreadId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = delegationLeases.get(threadId) ?? {
      semaphore: Semaphore.makeUnsafe(1),
      users: 0,
    };
    delegationLeases.set(threadId, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) delegationLeases.delete(threadId);
        }),
      ),
    );
  });

/** Ending an investigation stops every delegated task under the thread, committed with the end. */
export function investigationEffects(
  command: { readonly commandId: CommandId; readonly threadId: ThreadId },
  planned: ReadonlyArray<PlannedLedgerEvent>,
): ReadonlyArray<PendingOrchestrationEffectV2> {
  const ended = planned.find(
    (event) =>
      event.type === "ledger.investigation.updated" &&
      event.payload.investigation.status !== "running",
  );
  if (ended?.type !== "ledger.investigation.updated") return [];
  return [
    {
      id: `effect:${command.commandId}:investigation-stop`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: {
        type: "delegated-tasks.stop",
        reason:
          `Investigation ${ended.payload.investigation.status}: ${ended.payload.investigation.endReason ?? ""}`.trim(),
      },
    },
  ];
}
