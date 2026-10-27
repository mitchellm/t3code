import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Ledger,
  LedgerId,
  LedgerItemId,
  type LedgerInvestigation,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { guardInvestigationSpawn } from "./InvestigationSpawnGuard.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const planner = ThreadId.make("thread:planner");
const worker = ThreadId.make("thread:worker");
const NOW = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const endedAt = DateTime.add(NOW, { minutes: 10 });

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:investigate"),
  requestNamespace: "investigate-session",
  thread: {
    threadId,
    providerSessionId: "investigate-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const ledgerWith = (investigation: Partial<LedgerInvestigation>): Ledger => ({
  id: LedgerId.make("ledger:investigation:req"),
  threadId: planner,
  title: "Why does sync drop rows",
  startState: "",
  checkpoints: [],
  winConditions: [],
  items: [],
  requiresJudge: true,
  investigation: {
    goal: "Why does sync drop rows",
    solvedWhen: "A failing test passes with the fix.",
    budget: { minutes: 30 },
    parallelApproaches: 2,
    status: "running",
    approachesItemId: LedgerItemId.make("approaches"),
    startedAt: NOW,
    endedAt: null,
    ...investigation,
  },
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: investigation.status === undefined ? null : endedAt,
});

interface FakeThread {
  readonly parent: ThreadId | null;
  readonly ledger?: Ledger;
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

const guard = (tool: string, caller: ThreadId, threads: Readonly<Record<string, FakeThread>>) =>
  guardInvestigationSpawn(tool).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(caller)),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: ((threadId: ThreadId) => {
          const fake = threads[threadId]!;
          return Effect.succeed({
            thread: {
              lineage: {
                parentThreadId: fake.parent,
                relationshipToParent: fake.parent === null ? null : "subagent",
                rootThreadId: planner,
              },
            },
            subagents: [],
            runs: fake.runs ?? [],
            messages: fake.messages ?? [],
            ...(fake.ledger === undefined ? {} : { ledger: fake.ledger }),
          });
        }) as unknown as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
      }),
    ),
    Effect.exit,
  );

const refusalOf = (exit: Exit.Exit<void, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? String((exit.cause.reasons[0].error as { message?: unknown }).message)
    : undefined;

const reportTurn = (): Pick<FakeThread, "runs" | "messages"> => {
  const at = DateTime.add(endedAt, { minutes: 1 });
  return {
    runs: [
      {
        id: RunId.make("run:report"),
        ordinal: 2,
        status: "running",
        requestedAt: at,
        startedAt: at,
        completedAt: null,
      } as unknown as OrchestrationV2Run,
    ],
    messages: [
      {
        id: MessageId.make("message:report"),
        runId: RunId.make("run:report"),
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        createdAt: at,
      } as unknown as OrchestrationV2ConversationMessage,
    ],
  };
};

it.effect("create_threads is refused while an investigation runs, pointing at delegate_task", () =>
  Effect.gen(function* () {
    const exit = yield* guard("create_threads", planner, {
      [planner]: { parent: null, ledger: ledgerWith({}) },
    });
    expect(refusalOf(exit)).toContain("delegate_task");
  }),
);

it.effect(
  "t3_thread_send to a stopped worker is refused after the end, even in the report turn",
  () =>
    Effect.gen(function* () {
      const ended = { parent: null, ledger: ledgerWith({ status: "solved", endedAt }) } as const;
      const exit = yield* guard("t3_thread_send", planner, {
        [planner]: { ...ended, ...reportTurn() },
      });
      expect(refusalOf(exit)).toContain("has ended (solved");
      // A worker of the ended investigation cannot start work on its own either.
      const fromWorker = yield* guard("t3_thread_launch", worker, {
        [planner]: { ...ended, ...reportTurn() },
        [worker]: { parent: planner },
      });
      expect(refusalOf(fromWorker)).toContain("has ended (solved");
    }),
);

it.effect("a user-authored message after the end unlocks the thread", () =>
  Effect.gen(function* () {
    const askedAt = DateTime.add(endedAt, { minutes: 5 });
    const exit = yield* guard("t3_thread_send", planner, {
      [planner]: {
        parent: null,
        ledger: ledgerWith({ status: "solved", endedAt }),
        runs: [
          {
            id: RunId.make("run:user"),
            ordinal: 3,
            status: "running",
            requestedAt: askedAt,
            startedAt: askedAt,
            completedAt: null,
          } as unknown as OrchestrationV2Run,
        ],
        messages: [
          {
            id: MessageId.make("message:user"),
            runId: RunId.make("run:user"),
            role: "user",
            createdBy: "user",
            creationSource: "web",
            createdAt: askedAt,
          } as unknown as OrchestrationV2ConversationMessage,
        ],
      },
    });
    expect(Exit.isSuccess(exit)).toBe(true);
  }),
);
