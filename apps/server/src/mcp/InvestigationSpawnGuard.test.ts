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
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as Project from "../project/ProjectService.ts";
import { guardInvestigationSpawn } from "./InvestigationSpawnGuard.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

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

const threadsLayer = (threads: Readonly<Record<string, FakeThread>>) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
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
  });

const guard = (tool: string, caller: ThreadId, threads: Readonly<Record<string, FakeThread>>) =>
  guardInvestigationSpawn(tool).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(caller)),
    Effect.provide(threadsLayer(threads)),
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

it.effect("a worker under a running investigation cannot start threads or schedule work", () =>
  Effect.gen(function* () {
    // Threads a worker creates are not subagents, so nothing would count, stop or lock them.
    const tree = {
      [planner]: { parent: null, ledger: ledgerWith({}) },
      [worker]: { parent: planner },
    };
    for (const tool of ["create_threads", "schedule_task", "t3_thread_launch"]) {
      expect(refusalOf(yield* guard(tool, worker, tree))).toContain("delegate_task");
    }
  }),
);

it.effect("a scheduled task's message after the end does not unlock the thread", () =>
  Effect.gen(function* () {
    const firedAt = DateTime.add(endedAt, { minutes: 5 });
    const exit = yield* guard("t3_thread_send", planner, {
      [planner]: {
        parent: null,
        ledger: ledgerWith({ status: "solved", endedAt }),
        runs: [
          {
            id: RunId.make("run:scheduled"),
            ordinal: 3,
            status: "running",
            requestedAt: firedAt,
            startedAt: firedAt,
            completedAt: null,
          } as unknown as OrchestrationV2Run,
        ],
        messages: [
          {
            id: MessageId.make("message:scheduled"),
            runId: RunId.make("run:scheduled"),
            role: "user",
            // The scheduler stamps the task's own author and source, which a person set up.
            createdBy: "user",
            creationSource: "web",
            scheduledTaskId: ScheduledTaskId.make("task:nightly"),
            createdAt: firedAt,
          } as unknown as OrchestrationV2ConversationMessage,
        ],
      },
    });
    expect(refusalOf(exit)).toContain("has ended (solved");
  }),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "investigate-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "investigate-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const endedTree = {
  [planner]: { parent: null, ledger: ledgerWith({ status: "solved", endedAt }), ...reportTurn() },
} as const;

/** Calls a tool through its production registration, as the agent's MCP client would. */
const callRegistered = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(planner)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const toolRefusal = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? String(JSON.parse(text.text).message)
    : undefined;
};

it.effect("schedule_task updating a task is refused after the end, before the service runs", () =>
  callRegistered("schedule_task", { scheduledTaskId: "task:nightly", enabled: true }).pipe(
    Effect.map((result) => expect(toolRefusal(result)).toContain("has ended (solved")),
    Effect.provide(
      McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
            updateScheduledTask: () => Effect.die("an ended investigation must not reschedule"),
          }),
        ),
        Layer.provide(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(threadsLayer(endedTree)),
      ),
    ),
  ),
);

it.effect("t3_worktree_handoff is refused after the end, before the service runs", () =>
  callRegistered("t3_worktree_handoff", { branch: "agent/escape" }).pipe(
    Effect.map((result) => expect(toolRefusal(result)).toContain("has ended (solved")),
    Effect.provide(
      McpHttpServer.toolkitRegistration(WorktreeToolkit, WorktreeHandlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(WorktreeMcpService.WorktreeMcpService)({
            handoff: () => Effect.die("an ended investigation must not hand off"),
          }),
        ),
        // The toolkit's other tools need these; the refused call never reaches them.
        Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
        Layer.provide(Layer.mock(Project.ProjectService)({})),
        Layer.provide(threadsLayer(endedTree)),
      ),
    ),
  ),
);
