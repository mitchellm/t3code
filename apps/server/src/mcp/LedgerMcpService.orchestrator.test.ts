import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_LOADOUTS,
  EnvironmentId,
  LedgerId,
  LedgerItemId,
  type Loadout,
  MessageId,
  NodeId,
  type OrchestrationV2Subagent,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { runOrchestratorV2Scenario } from "../orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as LedgerMcpService from "./LedgerMcpService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Ledger commands never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const makeLayerOrchestrator = (serverSettings?: Parameters<typeof ServerSettings.layerTest>[0]) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProjectionMaintenance.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerDatabase,
          EventStore.layer.pipe(Layer.provide(layerDatabase)),
          ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ),
      ),
    ),
    ProviderReplayHarness.layerWithRegistry(
      { name: "ledger-mcp" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        ...(serverSettings === undefined ? {} : { serverSettings }),
      },
    ),
  );
const layerOrchestrator = makeLayerOrchestrator();

// The MCP service only needs dispatch and thread reads, so the real orchestrator sits behind them.
const layerThreads = Layer.unwrap(
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: orchestrator.getThreadShell,
      getThreadRecords: orchestrator.getThreadRecords,
      dispatch: orchestrator.dispatch,
      getProjectThreadRecords: ({ threadId }, fields) =>
        orchestrator.getThreadRecords(threadId, fields).pipe(Effect.orDie),
    }),
  ),
);

const threadId = ThreadId.make("thread:ledger-mcp-real");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:ledger-mcp"),
  requestNamespace: "ledger-mcp-session",
  thread: { threadId, providerSessionId: "ledger-mcp-session", providerInstanceId: instanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

it.effect("creates and reads a ledger through the real orchestrator and projection", () =>
  Effect.gen(function* () {
    const scenario = yield* runOrchestratorV2Scenario({
      name: "ledger-mcp-create-read",
      commands: [
        {
          type: "thread.create",
          commandId: CommandId.make("command:ledger-mcp:thread"),
          threadId,
          projectId: ProjectId.make("project:ledger-mcp"),
          title: "ledger mcp",
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        },
      ],
    });
    assert.isUndefined(scenario.projections.get(threadId)?.ledger);

    const service = yield* LedgerMcpService.LedgerMcpService;
    const create = {
      title: "Ship the parser",
      items: [
        { id: LedgerItemId.make("L1"), title: "Parse", acceptance: "tests pass" },
        { id: LedgerItemId.make("L2"), title: "Wire", acceptance: "smoke passes" },
      ],
    };
    const created = yield* service.create(scope, create);
    const read = yield* service.read(scope, {});
    // A write lists only the items it changed, here all of them, so the items match a read's.
    assert.equal(created.ledger?.changedOnly, true);
    assert.deepEqual(read.ledger?.items, created.ledger?.items);
    assert.equal(read.ledger?.unfinished, 2);

    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projected = (yield* orchestrator.getThreadProjection(threadId)).ledger;
    assert.equal(projected?.id, read.ledger?.ledgerId);
    assert.deepEqual(
      projected?.items.map((item) => [item.id, item.status]),
      [
        ["L1", "open"],
        ["L2", "open"],
      ],
    );

    // A lost response is retried with identical arguments and answers from the stored receipt.
    const retried = yield* service.create(scope, create);
    assert.deepEqual(retried, created);
    const close = yield* service.updateItem(scope, {
      itemId: LedgerItemId.make("L1"),
      status: "closed",
      evidence: "parser.test.ts: 12 passed",
    });
    assert.deepEqual(
      yield* service.updateItem(scope, {
        itemId: LedgerItemId.make("L1"),
        status: "closed",
        evidence: "parser.test.ts: 12 passed",
      }),
      close,
    );
    assert.equal(close.ledger?.unfinished, 1);
  }).pipe(
    Effect.provide(
      LedgerMcpService.layer.pipe(
        Layer.provideMerge(layerThreads),
        Layer.provideMerge(layerOrchestrator),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(ServerSettings.layerTest({ taskLedger: true })),
      ),
    ),
  ),
);

/** As `layerThreads`, but the thread's task records come from `taskRecords`, which a test moves. */
const layerThreadsWithTasks = (taskRecords: Map<NodeId, OrchestrationV2Subagent["status"]>) =>
  Layer.unwrap(
    Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: orchestrator.getThreadShell,
        dispatch: orchestrator.dispatch,
        getProjectThreadRecords: ({ threadId }, fields) =>
          orchestrator.getThreadRecords(threadId, fields).pipe(
            Effect.map((records) => ({
              ...records,
              subagents: [...taskRecords].map(([id, status]) => ({ id, status }) as never),
            })),
            Effect.orDie,
          ),
      }),
    ),
  );

it.effect(
  "ledger_read lists each item's tasks with role, model, child thread and live status",
  () => {
    const taskRecords = new Map<NodeId, OrchestrationV2Subagent["status"]>();
    return Effect.gen(function* () {
      const tasksThreadId = ThreadId.make("thread:ledger-mcp-tasks");
      const tasksScope: McpInvocationContext.McpInvocationScope = {
        ...scope,
        thread: {
          threadId: tasksThreadId,
          providerSessionId: "ledger-mcp-session",
          providerInstanceId: instanceId,
        },
      };
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:ledger-mcp-tasks:thread"),
        threadId: tasksThreadId,
        projectId: ProjectId.make("project:ledger-mcp"),
        title: "ledger tasks",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const service = yield* LedgerMcpService.LedgerMcpService;
      const created = yield* service.create(tasksScope, {
        title: "Ship the parser",
        items: [
          { id: LedgerItemId.make("L1"), title: "Parse", acceptance: "tests pass" },
          { id: LedgerItemId.make("L2"), title: "Wire", acceptance: "smoke passes" },
        ],
      });
      const taskId = NodeId.make("task:ledger-mcp-explore");
      yield* orchestrator.dispatch({
        type: "ledger.item.task.link",
        commandId: CommandId.make("command:ledger-mcp-tasks:link"),
        threadId: tasksThreadId,
        ledgerId: LedgerId.make(created.ledger!.ledgerId),
        itemId: LedgerItemId.make("L1"),
        task: {
          taskId,
          childThreadId: ThreadId.make("thread:ledger-mcp-explorer"),
          role: "explorer",
          providerInstanceId: instanceId,
          model: "gpt-5.1-codex-mini",
        },
      });
      taskRecords.set(taskId, "running");
      const running = yield* service.read(tasksScope, {});
      assert.deepEqual(running.ledger?.items[0]?.tasks, [
        {
          taskId,
          role: "explorer",
          model: "gpt-5.1-codex-mini",
          status: "running",
          childThreadId: ThreadId.make("thread:ledger-mcp-explorer"),
        },
      ]);
      // An item with no tasks stays as compact as before.
      assert.notProperty(running.ledger?.items[1] ?? {}, "tasks");

      // Status is read from the task each time, never stored on the ledger.
      taskRecords.set(taskId, "completed");
      assert.equal(
        (yield* service.read(tasksScope, {})).ledger?.items[0]?.tasks?.[0]?.status,
        "completed",
      );
      taskRecords.delete(taskId);
      assert.isNull((yield* service.read(tasksScope, {})).ledger?.items[0]?.tasks?.[0]?.status);
    }).pipe(
      Effect.provide(
        LedgerMcpService.layer.pipe(
          Layer.provideMerge(layerThreadsWithTasks(taskRecords)),
          Layer.provideMerge(layerOrchestrator),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(ServerSettings.layerTest({ taskLedger: true })),
        ),
      ),
    );
  },
);

const stampProjectId = ProjectId.make("project:ledger-mcp-stamp");
const judgedLoadout: Loadout = {
  id: "judged-codex",
  name: "Judged",
  description: "A judge on an instance this server runs",
  roles: { judge: { instanceId, model: "gpt-5.1-codex" } },
};

/**
 * The ledger the orchestrator made on a fresh thread under these settings, and what ledger_read
 * showed. These tests are about the stamps, so the task ledger is on unless a test turns it off.
 */
const stampedFull = (input: {
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly loadoutId?: string;
  readonly start?: "create" | "investigation";
}) => {
  const settings = { taskLedger: true, ...input.settings };
  const stampThreadId = ThreadId.make("thread:ledger-mcp-stamp");
  const stampScope: McpInvocationContext.McpInvocationScope = {
    ...scope,
    thread: {
      threadId: stampThreadId,
      providerSessionId: "ledger-mcp-session",
      providerInstanceId: instanceId,
    },
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:ledger-mcp-stamp:thread"),
      threadId: stampThreadId,
      projectId: stampProjectId,
      title: "ledger stamp",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    if (input.loadoutId !== undefined) {
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("command:ledger-mcp-stamp:loadout"),
        threadId: stampThreadId,
        loadout: { id: input.loadoutId, reason: null, setBy: "user" },
      });
    }
    const service = yield* LedgerMcpService.LedgerMcpService;
    let shown: boolean | undefined;
    let shownFails: number | undefined;
    if (input.start === "investigation") {
      yield* orchestrator.dispatch({
        type: "ledger.investigation.start",
        commandId: CommandId.make("command:ledger-mcp-stamp:investigation"),
        threadId: stampThreadId,
        ledgerId: LedgerId.make("ledger:ledger-mcp-stamp"),
        goal: "Why does the parser drop rows",
        solvedWhen: "A failing test passes with the fix.",
        budget: { minutes: 30 },
        parallelApproaches: 2,
      });
      shown = (yield* service.read(stampScope, {})).ledger?.askCheck;
    } else {
      const created = yield* service.create(stampScope, {
        title: "Ship the parser",
        items: [{ id: LedgerItemId.make("L1"), title: "Parse", acceptance: "tests pass" }],
      });
      shown = created.ledger?.askCheck;
      shownFails = created.ledger?.askCheckFails;
    }
    const ledger = (yield* orchestrator.getThreadProjection(stampThreadId)).ledger;
    return { ledger, shown, shownFails };
  }).pipe(
    Effect.provide(
      LedgerMcpService.layer.pipe(
        Layer.provideMerge(layerThreads),
        Layer.provideMerge(makeLayerOrchestrator(settings)),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(ServerSettings.layerTest(settings)),
      ),
    ),
  );
};

/** What the orchestrator stamps on a ledger made on a fresh thread, under these settings. */
const stampedLedger = (input: Parameters<typeof stampedFull>[0]) =>
  stampedFull(input).pipe(
    Effect.map(({ ledger, shown }) => ({
      askCheck: ledger?.askCheck,
      requiresJudge: ledger?.requiresJudge,
      shown,
    })),
  );

/** The ask check policy the ledger was stamped with, and the failed-check count ledger_read showed. */
const stampedPolicy = (input: Parameters<typeof stampedFull>[0]) =>
  stampedFull(input).pipe(
    Effect.map(({ ledger, shownFails }) => ({
      policy: ledger?.askCheckPolicy,
      shownFails,
    })),
  );

it.effect(
  "a plain thread's new ledger is stamped for the ask check only once the setting is on",
  () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* stampedLedger({ settings: { askCheck: true } }), {
        askCheck: true,
        requiresJudge: undefined,
        shown: true,
      });
      assert.isTrue(
        (yield* stampedLedger({
          settings: { projectSettingsOverrides: { [stampProjectId]: { askCheck: true } } },
        })).askCheck,
      );
    }),
);

it.effect(
  "with the setting off, by default or set off for the server or the project, a plain thread stamps neither flag",
  () =>
    Effect.gen(function* () {
      const none = { askCheck: undefined, requiresJudge: undefined, shown: undefined };
      assert.deepEqual(yield* stampedLedger({}), none);
      assert.deepEqual(yield* stampedLedger({ settings: { askCheck: false } }), none);
      assert.deepEqual(
        yield* stampedLedger({
          settings: {
            askCheck: true,
            projectSettingsOverrides: { [stampProjectId]: { askCheck: false } },
          },
        }),
        none,
      );
    }),
);

it.effect(
  "with the task ledger off for the server or the project, a plain thread cannot create one but a loadout with roles can",
  () =>
    Effect.gen(function* () {
      for (const settings of [
        { taskLedger: false },
        { projectSettingsOverrides: { [stampProjectId]: { taskLedger: false } } },
      ]) {
        const refused = yield* Effect.flip(stampedLedger({ settings }));
        assert.instanceOf(refused, OrchestratorMcpFailure);
        assert.strictEqual(refused.code, "capability_denied");
        assert.include(refused.message, "The task ledger is off for this project");
        // Solo is the same as no loadout.
        const solo = yield* Effect.flip(stampedLedger({ settings, loadoutId: "solo" }));
        assert.instanceOf(solo, OrchestratorMcpFailure);
        assert.strictEqual(solo.code, "capability_denied");
        assert.deepEqual(
          yield* stampedLedger({
            settings: { ...settings, loadouts: [...DEFAULT_LOADOUTS, judgedLoadout] },
            loadoutId: judgedLoadout.id,
          }),
          { askCheck: undefined, requiresJudge: true, shown: undefined },
        );
      }
    }),
);

it.effect("a loadout with a judge stamps requiresJudge and never the ask check", () =>
  Effect.gen(function* () {
    const settings = { loadouts: [...DEFAULT_LOADOUTS, judgedLoadout] };
    assert.deepEqual(yield* stampedLedger({ settings, loadoutId: judgedLoadout.id }), {
      askCheck: undefined,
      requiresJudge: true,
      shown: undefined,
    });
  }),
);

// One agent builds and its judge model checks the finished asks, instead of judging each item.
const soloJudgedLoadout: Loadout = {
  ...judgedLoadout,
  id: "solo-judged",
  name: "Solo judged",
  structure: "solo",
};
// The same, with a judge on an instance this server does not run.
const soloUnrunnableLoadout: Loadout = {
  ...soloJudgedLoadout,
  id: "solo-unrunnable",
  roles: {
    judge: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  },
};

it.effect(
  "a solo-structured loadout with a runnable judge gets the ask check, whatever the setting",
  () =>
    Effect.gen(function* () {
      const loadouts = [...DEFAULT_LOADOUTS, soloJudgedLoadout];
      const checked = { askCheck: true, requiresJudge: undefined, shown: true } as const;
      assert.deepEqual(
        yield* stampedLedger({ settings: { loadouts }, loadoutId: soloJudgedLoadout.id }),
        checked,
      );
      assert.deepEqual(
        yield* stampedLedger({
          settings: { loadouts, askCheck: false },
          loadoutId: soloJudgedLoadout.id,
        }),
        checked,
      );
    }),
);

it.effect("a solo-structured loadout whose judge cannot run falls back to the setting", () =>
  Effect.gen(function* () {
    const loadouts = [...DEFAULT_LOADOUTS, soloUnrunnableLoadout];
    const stamped = (askCheck: boolean) =>
      stampedLedger({ settings: { loadouts, askCheck }, loadoutId: soloUnrunnableLoadout.id });
    assert.deepEqual(yield* stamped(true), {
      askCheck: true,
      requiresJudge: undefined,
      shown: true,
    });
    assert.deepEqual(yield* stamped(false), {
      askCheck: undefined,
      requiresJudge: undefined,
      shown: undefined,
    });
  }),
);

it.effect("an investigation under a solo-structured judge is still judged by its refuter", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* stampedLedger({
        settings: { loadouts: [...DEFAULT_LOADOUTS, soloJudgedLoadout] },
        loadoutId: soloJudgedLoadout.id,
        start: "investigation",
      }),
      { askCheck: undefined, requiresJudge: true, shown: undefined },
    );
  }),
);

it.effect("an investigation is judged by its refuter and gets no ask check", () =>
  Effect.gen(function* () {
    const settings = { loadouts: [...DEFAULT_LOADOUTS, judgedLoadout] };
    assert.deepEqual(
      yield* stampedLedger({ settings, loadoutId: judgedLoadout.id, start: "investigation" }),
      { askCheck: undefined, requiresJudge: true, shown: undefined },
    );
  }),
);

it.effect(
  "the v2 ask check policy is stamped on the ledger at creation, and ledger_read counts",
  () =>
    Effect.gen(function* () {
      // The capped policy is the default; a project that sets nothing gets it.
      assert.deepEqual(yield* stampedPolicy({ settings: { askCheck: true } }), {
        policy: "v2",
        shownFails: 0,
      });
      // v1 is the earlier behaviour: the ledger carries no policy and shows no count.
      assert.deepEqual(
        yield* stampedPolicy({ settings: { askCheck: true, askCheckPolicy: "v1" } }),
        { policy: undefined, shownFails: undefined },
      );
      assert.deepEqual(
        yield* stampedPolicy({
          settings: {
            askCheck: true,
            projectSettingsOverrides: { [stampProjectId]: { askCheckPolicy: "v1" } },
          },
        }),
        { policy: undefined, shownFails: undefined },
      );
      assert.deepEqual(
        yield* stampedPolicy({ settings: { askCheck: true, askCheckPolicy: "v2" } }),
        { policy: "v2", shownFails: 0 },
      );
      // A project's own choice wins over the server's.
      assert.deepEqual(
        yield* stampedPolicy({
          settings: {
            askCheck: true,
            projectSettingsOverrides: { [stampProjectId]: { askCheckPolicy: "v2" } },
          },
        }),
        { policy: "v2", shownFails: 0 },
      );
      assert.deepEqual(
        yield* stampedPolicy({
          settings: {
            askCheck: true,
            askCheckPolicy: "v2",
            projectSettingsOverrides: { [stampProjectId]: { askCheckPolicy: "v1" } },
          },
        }),
        { policy: undefined, shownFails: undefined },
      );
    }),
);

it.effect(
  "the policy is stamped only where an ask check is: not off, not judged, not an investigation",
  () =>
    Effect.gen(function* () {
      const none = { policy: undefined, shownFails: undefined };
      assert.deepEqual(
        yield* stampedPolicy({ settings: { askCheckPolicy: "v2", askCheck: false } }),
        none,
      );
      assert.deepEqual(
        yield* stampedPolicy({
          settings: { askCheckPolicy: "v2", loadouts: [...DEFAULT_LOADOUTS, judgedLoadout] },
          loadoutId: judgedLoadout.id,
        }),
        none,
      );
      assert.deepEqual(
        yield* stampedPolicy({
          settings: { askCheckPolicy: "v2", loadouts: [...DEFAULT_LOADOUTS, judgedLoadout] },
          loadoutId: judgedLoadout.id,
          start: "investigation",
        }),
        none,
      );
      // A solo-structured loadout with a runnable judge is an ask check ledger whatever the setting.
      assert.deepEqual(
        yield* stampedPolicy({
          settings: {
            askCheckPolicy: "v2",
            askCheck: false,
            loadouts: [...DEFAULT_LOADOUTS, soloJudgedLoadout],
          },
          loadoutId: soloJudgedLoadout.id,
        }),
        { policy: "v2", shownFails: 0 },
      );
    }),
);

it.effect("a model switch made before a server wake is the model the wake's turn starts on", () =>
  Effect.gen(function* () {
    // The v2 hand-over switches the thread with the command t3_thread_configure sends, then queues
    // the wake without naming a model: the run it starts must carry the new selection.
    const handOverThreadId = ThreadId.make("thread:ledger-mcp-hand-over");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:ledger-mcp-hand-over:thread"),
      threadId: handOverThreadId,
      projectId: stampProjectId,
      title: "ledger hand over",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("command:ledger-mcp-hand-over:switch"),
      threadId: handOverThreadId,
      modelSelection: { instanceId, model: "gpt-5.1-codex-max" },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:ledger-mcp-hand-over:wake"),
      threadId: handOverThreadId,
      messageId: MessageId.make("message:ledger-mcp-hand-over:wake"),
      text: "The check failed twice.",
      notification: { source: { kind: "system" }, outcome: "failed", summary: "The check failed" },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    const projection = yield* orchestrator.getThreadProjection(handOverThreadId);
    assert.equal(projection.thread.modelSelection.model, "gpt-5.1-codex-max");
    assert.deepEqual(
      projection.runs.map((run) => run.modelSelection.model),
      ["gpt-5.1-codex-max"],
    );
  }).pipe(
    Effect.provide(
      LedgerMcpService.layer.pipe(
        Layer.provideMerge(layerThreads),
        Layer.provideMerge(layerOrchestrator),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(ServerSettings.layerTest({ taskLedger: true })),
      ),
    ),
  ),
);

const stopSettings = { taskLedger: true, askCheck: true, askCheckPolicy: "v2" } as const;

it.effect("a person's message lifts a v2 stop, and nothing the server or an agent sends does", () =>
  Effect.gen(function* () {
    const stopThreadId = ThreadId.make("thread:ledger-mcp-stop");
    const stopScope: McpInvocationContext.McpInvocationScope = {
      ...scope,
      thread: {
        threadId: stopThreadId,
        providerSessionId: "ledger-mcp-session",
        providerInstanceId: instanceId,
      },
    };
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:ledger-mcp-stop:thread"),
      threadId: stopThreadId,
      projectId: stampProjectId,
      title: "ledger stop",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const service = yield* LedgerMcpService.LedgerMcpService;
    const created = yield* service.create(stopScope, {
      title: "Ship the parser",
      items: [{ id: LedgerItemId.make("L1"), title: "Parse", acceptance: "tests pass" }],
    });
    const ledgerId = LedgerId.make(created.ledger!.ledgerId);
    yield* service.updateItem(stopScope, {
      itemId: LedgerItemId.make("L1"),
      status: "in_progress",
    });
    const at = yield* DateTime.now;
    for (const attempt of [1, 2, 3]) {
      yield* orchestrator.dispatch({
        type: "ledger.item.verdict.record",
        commandId: CommandId.make(`command:ledger-mcp-stop:fail:${attempt}`),
        threadId: stopThreadId,
        ledgerId,
        itemId: LedgerItemId.make("L1"),
        verdict: {
          outcome: "fail",
          judge: { instanceId, model: "gpt-5.1-codex" },
          notes: `fail ${attempt}`,
          at,
        },
      });
    }
    const ledgerNow = () =>
      Effect.map(orchestrator.getThreadProjection(stopThreadId), ({ ledger }) => ledger);
    const stopped = yield* ledgerNow();
    assert.equal(stopped?.askCheckFails, 3);
    assert.equal(stopped?.askCheckStopped?.fails, 3);
    const read = (yield* service.read(stopScope, {})).ledger;
    assert.equal(read?.askCheckFails, 3);
    assert.isTrue(read?.askCheckStopped);
    // The agent's close of the held ask is refused, with the text that tells it what to do.
    const refused = yield* Effect.flip(
      service.updateItem(stopScope, {
        itemId: LedgerItemId.make("L1"),
        status: "closed",
        evidence: "parser.test.ts: 12 passed",
      }),
    );
    assert.include(
      JSON.stringify(refused),
      "The check failed three times and has stopped. Tell the user what is done",
    );

    const send = (
      name: string,
      createdBy: "user" | "agent",
      creationSource: "web" | "server" | "mcp",
    ) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:ledger-mcp-stop:${name}`),
        threadId: stopThreadId,
        messageId: MessageId.make(`message:ledger-mcp-stop:${name}`),
        text: name,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy,
        creationSource,
      });
    yield* send("wake", "agent", "server");
    yield* send("from-an-agent", "user", "mcp");
    assert.isDefined((yield* ledgerNow())?.askCheckStopped);

    // Nothing but a person's message gives the check a fresh budget: the count stands as well.
    assert.equal((yield* ledgerNow())?.askCheckFails, 3);

    yield* send("person", "user", "web");
    const resumed = yield* ledgerNow();
    assert.isUndefined(resumed?.askCheckStopped);
    // The new message starts the budget again, so it takes three more failed checks to stop it.
    assert.equal(resumed?.askCheckFails, 0);
  }).pipe(
    Effect.provide(
      LedgerMcpService.layer.pipe(
        Layer.provideMerge(layerThreads),
        Layer.provideMerge(makeLayerOrchestrator(stopSettings)),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(ServerSettings.layerTest(stopSettings)),
      ),
    ),
  ),
);

// A thread's own model, the stronger checker's, and a third a person might pick themselves.
const ownSelection = { instanceId, model: "gpt-5.1-codex" };
const strongerSelection = { instanceId, model: "gpt-5.1-codex-max" };
const pickedSelection = { instanceId, model: "gpt-5.1-codex-mini" };

/**
 * A thread whose ledger is in progress under the v2 policy, with the tools to fail its checks,
 * hand it over as the server does (the model switch, then the verdict that records it) and have
 * a person or the server write to it.
 */
const checkedThread = (name: string) =>
  Effect.gen(function* () {
    const budgetThreadId = ThreadId.make(`thread:ledger-mcp-budget:${name}`);
    const budgetScope: McpInvocationContext.McpInvocationScope = {
      ...scope,
      thread: {
        threadId: budgetThreadId,
        providerSessionId: "ledger-mcp-session",
        providerInstanceId: instanceId,
      },
    };
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const service = yield* LedgerMcpService.LedgerMcpService;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:ledger-mcp-budget:${name}:thread`),
      threadId: budgetThreadId,
      projectId: stampProjectId,
      title: `ledger budget ${name}`,
      modelSelection: ownSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const created = yield* service.create(budgetScope, {
      title: "Ship the parser",
      items: [{ id: LedgerItemId.make("L1"), title: "Parse", acceptance: "tests pass" }],
    });
    const ledgerId = LedgerId.make(created.ledger!.ledgerId);
    yield* service.updateItem(budgetScope, {
      itemId: LedgerItemId.make("L1"),
      status: "in_progress",
    });
    const at = yield* DateTime.now;
    let step = 0;
    const failCheck = (handOver?: boolean) =>
      Effect.gen(function* () {
        step += 1;
        if (handOver === true) {
          // As the server does: the same command t3_thread_configure sends, then the verdict.
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`command:ledger-mcp-budget:${name}:switch:${step}`),
            threadId: budgetThreadId,
            modelSelection: strongerSelection,
          });
        }
        yield* orchestrator.dispatch({
          type: "ledger.item.verdict.record",
          commandId: CommandId.make(`command:ledger-mcp-budget:${name}:fail:${step}`),
          threadId: budgetThreadId,
          ledgerId,
          itemId: LedgerItemId.make("L1"),
          verdict: { outcome: "fail", judge: strongerSelection, notes: `fail ${step}`, at },
          ...(handOver === true
            ? {
                handOver: { from: ownSelection.model, to: strongerSelection.model },
                handOverSelections: { from: ownSelection, to: strongerSelection },
              }
            : {}),
        });
      });
    const send = (
      text: string,
      source: {
        readonly createdBy: "user" | "agent";
        readonly creationSource: "web" | "mcp" | "server";
        readonly notification?: Extract<
          Parameters<typeof orchestrator.dispatch>[0],
          { readonly type: "message.dispatch" }
        >["notification"];
        readonly scheduledTaskId?: ScheduledTaskId;
        readonly modelSelection?: typeof ownSelection;
      } = { createdBy: "user", creationSource: "web" },
    ) => {
      step += 1;
      return orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:ledger-mcp-budget:${name}:send:${step}`),
        threadId: budgetThreadId,
        messageId: MessageId.make(`message:ledger-mcp-budget:${name}:send:${step}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        ...source,
      });
    };
    const state = () => orchestrator.getThreadProjection(budgetThreadId);
    const notices = () =>
      Effect.map(
        orchestrator.getThreadRecords(budgetThreadId, ["turnItems"], {
          turnItemTypes: ["system_notice"],
        }),
        ({ turnItems }) =>
          turnItems.flatMap((item) => (item.type === "system_notice" ? [item.message] : [])),
      );
    return {
      orchestrator,
      service,
      budgetScope,
      budgetThreadId,
      ledgerId,
      failCheck,
      send,
      state,
      notices,
    };
  });

const withBudgetLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      LedgerMcpService.layer.pipe(
        Layer.provideMerge(layerThreads),
        Layer.provideMerge(makeLayerOrchestrator(stopSettings)),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(ServerSettings.layerTest(stopSettings)),
      ),
    ),
  );

it.effect(
  "a person's new message starts the check's budget again however the agent reuses the ledger",
  () =>
    withBudgetLayers(
      Effect.gen(function* () {
        for (const reuse of ["adds an ask", "reopens the ledger"] as const) {
          const t = yield* checkedThread(reuse.replace(" ", "-"));
          yield* t.failCheck();
          yield* t.failCheck(true);
          yield* t.failCheck();
          assert.equal((yield* t.state()).ledger?.askCheckStopped?.fails, 3);
          if (reuse === "reopens the ledger") {
            // The person closes the held ask themselves, which closes the finished ledger.
            yield* t.orchestrator.dispatch({
              type: "ledger.item.update",
              commandId: CommandId.make("command:ledger-mcp-budget:reopen:user-close"),
              threadId: t.budgetThreadId,
              ledgerId: t.ledgerId,
              itemId: LedgerItemId.make("L1"),
              status: "closed",
              evidence: "closed by the user",
            });
            assert.isNotNull((yield* t.state()).ledger?.closedAt);
          }

          yield* t.send("now please add logging to the parser");
          const fresh = (yield* t.state()).ledger;
          assert.equal(fresh?.askCheckFails, 0, reuse);
          assert.isUndefined(fresh?.askCheckStopped, reuse);
          assert.isUndefined(fresh?.askCheckHandedOver, reuse);

          if (reuse === "adds an ask") {
            yield* t.service.addItems(t.budgetScope, {
              items: [
                {
                  id: LedgerItemId.make("L2"),
                  title: "Logging",
                  acceptance: "the parser logs",
                  quote: "add logging to the parser",
                },
              ],
            });
          } else {
            yield* t.service.reopen(t.budgetScope, {});
            yield* t.service.updateItem(t.budgetScope, {
              itemId: LedgerItemId.make("L1"),
              status: "open",
            });
          }
          // The ask is checked, not refused with the stop text.
          const heldItem = LedgerItemId.make(reuse === "adds an ask" ? "L2" : "L1");
          if (reuse === "adds an ask") {
            yield* t.service.updateItem(t.budgetScope, {
              itemId: LedgerItemId.make("L1"),
              status: "closed",
              evidence: "parser.test.ts: 12 passed",
            });
          }
          yield* t.service.updateItem(t.budgetScope, {
            itemId: heldItem,
            status: "closed",
            evidence: "parser.test.ts: 14 passed",
          });
          const judging = (yield* t.state()).ledger?.items.find(({ id }) => id === heldItem);
          assert.isTrue(judging?.judging, reuse);
          // One failed check on the new request is the first of its three, not a fourth overall.
          yield* t.orchestrator.dispatch({
            type: "ledger.item.verdict.record",
            commandId: CommandId.make(`command:ledger-mcp-budget:${reuse}:fail-again`),
            threadId: t.budgetThreadId,
            ledgerId: t.ledgerId,
            itemId: heldItem,
            verdict: {
              outcome: "fail",
              judge: strongerSelection,
              notes: "not yet",
              at: yield* DateTime.now,
            },
          });
          const once = (yield* t.state()).ledger;
          assert.equal(once?.askCheckFails, 1, reuse);
          assert.isUndefined(once?.askCheckStopped, reuse);
        }
      }),
    ),
);

it.effect(
  "a thread handed to the checker's model is back on its own at the next message, once",
  () =>
    withBudgetLayers(
      Effect.gen(function* () {
        const t = yield* checkedThread("return");
        yield* t.failCheck();
        yield* t.failCheck(true);
        const handedOver = yield* t.state();
        assert.equal(handedOver.thread.modelSelection.model, strongerSelection.model);
        assert.deepEqual(handedOver.ledger?.askCheckHandedOver?.selections, {
          from: ownSelection,
          to: strongerSelection,
        });

        yield* t.send("a new request");
        const back = yield* t.state();
        assert.equal(back.thread.modelSelection.model, ownSelection.model);
        assert.deepEqual(
          back.runs.map((run) => run.modelSelection.model),
          [ownSelection.model],
        );
        assert.equal(back.ledger?.askCheckFails, 0);
        assert.isUndefined(back.ledger?.askCheckHandedOver);
        assert.deepEqual(yield* t.notices(), [
          `This thread is back on ${ownSelection.model}; ${strongerSelection.model} took over only for the last request.`,
        ]);

        // Another message, and a server wake, say nothing more and change nothing.
        yield* t.send("and another thing");
        yield* t.send("the server's wake", {
          createdBy: "agent",
          creationSource: "server",
          notification: { source: { kind: "system" }, outcome: "updated", summary: "A wake" },
        });
        assert.equal((yield* t.notices()).length, 1);
        assert.equal((yield* t.state()).thread.modelSelection.model, ownSelection.model);

        // Two failed checks on the new request hand the thread over again, as on the first.
        yield* t.failCheck();
        yield* t.failCheck(true);
        const again = yield* t.state();
        assert.equal(again.ledger?.askCheckFails, 2);
        assert.equal(again.ledger?.askCheckHandedOver?.to, strongerSelection.model);
        assert.isUndefined(again.ledger?.askCheckStopped);
        assert.equal(again.thread.modelSelection.model, strongerSelection.model);
      }),
    ),
);

it.effect("a model the person picked after the hand-over is not switched back", () =>
  withBudgetLayers(
    Effect.gen(function* () {
      // They changed the thread's model before writing, or wrote with another model chosen.
      const beforeWriting = yield* checkedThread("picked-before");
      yield* beforeWriting.failCheck();
      yield* beforeWriting.failCheck(true);
      yield* beforeWriting.orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("command:ledger-mcp-budget:picked-before:pick"),
        threadId: beforeWriting.budgetThreadId,
        modelSelection: pickedSelection,
      });
      yield* beforeWriting.send("a new request");
      const kept = yield* beforeWriting.state();
      assert.equal(kept.thread.modelSelection.model, pickedSelection.model);
      assert.deepEqual(
        kept.runs.map((run) => run.modelSelection.model),
        [pickedSelection.model],
      );
      assert.deepEqual(yield* beforeWriting.notices(), []);
      // The budget is still fresh: that is about checks, not the model.
      assert.equal(kept.ledger?.askCheckFails, 0);
      assert.isUndefined(kept.ledger?.askCheckHandedOver);

      const withMessage = yield* checkedThread("picked-with");
      yield* withMessage.failCheck();
      yield* withMessage.failCheck(true);
      yield* withMessage.send("a new request", {
        createdBy: "user",
        creationSource: "web",
        modelSelection: pickedSelection,
      });
      const sent = yield* withMessage.state();
      assert.equal(sent.thread.modelSelection.model, pickedSelection.model);
      assert.deepEqual(yield* withMessage.notices(), []);
    }),
  ),
);

it.effect("nothing but a person's message gives the budget back or returns the model", () =>
  withBudgetLayers(
    Effect.gen(function* () {
      const t = yield* checkedThread("not-a-person");
      yield* t.failCheck();
      yield* t.failCheck(true);
      const sources = [
        [
          "a wake",
          {
            createdBy: "agent",
            creationSource: "server",
            notification: {
              source: { kind: "system" },
              outcome: "failed",
              summary: "The check failed",
            },
          },
        ],
        [
          "an auto-continue",
          {
            createdBy: "agent",
            creationSource: "server",
            notification: {
              source: { kind: "ledger_continue", round: 1, items: [] },
              outcome: "updated",
              summary: "Continuing",
            },
          },
        ],
        [
          "a background task's notice",
          {
            createdBy: "agent",
            creationSource: "server",
            notification: {
              source: { kind: "background_task" },
              outcome: "completed",
              summary: "Done",
            },
          },
        ],
        [
          "a delegated task's result",
          {
            createdBy: "agent",
            creationSource: "server",
            notification: {
              source: { kind: "delegated_task", taskIds: [NodeId.make("task:ledger-mcp-budget")] },
              outcome: "completed",
              summary: "Done",
            },
          },
        ],
        ["a usage-limit resume", { createdBy: "user", creationSource: "server" }],
        [
          "a scheduled run",
          {
            createdBy: "user",
            creationSource: "web",
            scheduledTaskId: ScheduledTaskId.make("scheduled:ledger-mcp-budget"),
          },
        ],
        ["an agent's or the CLI's message", { createdBy: "user", creationSource: "mcp" }],
      ] as const;
      for (const [name, source] of sources) {
        yield* t.send(name, source);
        const after = yield* t.state();
        assert.equal(after.ledger?.askCheckFails, 2, name);
        assert.isDefined(after.ledger?.askCheckHandedOver, name);
        assert.equal(after.thread.modelSelection.model, strongerSelection.model, name);
        assert.deepEqual(yield* t.notices(), [], name);
      }
    }),
  ),
);
