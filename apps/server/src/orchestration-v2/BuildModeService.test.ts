import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  LedgerId,
  LedgerItemId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as BuildModeService from "./BuildModeService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const codex = ProviderInstanceId.make("codex");
// No provider ever answers: runs stay open, which is all a dispatch-level test needs.
const adapter = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("unused"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const snapshot: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-06-17T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  slashCommands: [{ name: "compact" }],
  skills: [],
};

const projectId = ProjectId.make("project:build-mode");
const subjectId = ThreadId.make("thread:build-mode-subject");
const AUDIT_ANSWER = "FINDING: Plan skips the migration | A migration runs in CI";

interface Controls {
  readonly failBuildDispatch: Ref.Ref<boolean>;
  readonly releaseJudge: Deferred.Deferred<void>;
}

const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "build-mode-service" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);
const layerSettings = ServerSettings.layerTest({
  loadouts: [
    {
      id: "judged",
      name: "Judged",
      description: "",
      roles: { judge: { instanceId: codex, model: "gpt-5.4" } },
    },
  ],
});
const layerThreads = ThreadManagementService.layer.pipe(
  Layer.provideMerge(layerOrchestrator),
  Layer.provide(layerSettings),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
);
const ControlsTag = Effect.gen(function* () {
  return {
    failBuildDispatch: yield* Ref.make(false),
    releaseJudge: yield* Deferred.make<void>(),
  } satisfies Controls;
});

/**
 * The real thread service, except that a build dispatch can be made to fail and the judge's run
 * "finishes" when the test releases it, answering with AUDIT_ANSWER.
 */
const makeLayerTest = (controls: Controls) => {
  const layerControlledThreads = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagementService.ThreadManagementService;
      return ThreadManagementService.ThreadManagementService.of({
        ...real,
        dispatch: (command) =>
          Effect.gen(function* () {
            if (
              command.type === "message.dispatch" &&
              (yield* Ref.get(controls.failBuildDispatch))
            ) {
              return yield* Effect.die("build dispatch refused");
            }
            return yield* real.dispatch(command);
          }),
        waitForThread: (input) =>
          Effect.gen(function* () {
            yield* Deferred.await(controls.releaseJudge);
            const { runs } = yield* real.getThreadRecords(input.threadId, ["runs"]);
            const run = runs.find((candidate) => candidate.id === input.runId) ?? null;
            return {
              threadId: input.threadId,
              run: run === null ? null : { ...run, status: "completed" as const },
              timedOut: false,
            };
          }).pipe(Effect.orDie),
        getThreadRecords: ((threadId, fields, filter) =>
          threadId.startsWith("thread:audit:") && filter?.messageRoles?.[0] === "assistant"
            ? real.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }).pipe(
                Effect.map((records) => ({
                  ...records,
                  messages: records.messages.map((message) => ({
                    ...message,
                    role: "assistant" as const,
                    text: AUDIT_ANSWER,
                  })),
                })),
              )
            : real.getThreadRecords(threadId, fields, filter)) as typeof real.getThreadRecords,
      });
    }),
  ).pipe(Layer.provide(layerThreads));
  return BuildModeService.layer.pipe(
    Layer.provide(layerControlledThreads),
    Layer.provideMerge(layerThreads),
    Layer.provide(ProviderRegistryMock.layer([snapshot])),
    Layer.provide(layerSettings),
    Layer.provide(NodeCrypto.layer),
  );
};

const withService = <A, E>(
  body: (input: {
    readonly service: BuildModeService.BuildModeService["Service"];
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly controls: Controls;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const controls = yield* ControlsTag;
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:build-mode:create"),
        threadId: subjectId,
        projectId,
        title: "Subject",
        createdBy: "user",
        creationSource: "web",
        modelSelection: { instanceId: codex, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "ledger.create",
        commandId: CommandId.make("command:build-mode:ledger"),
        threadId: subjectId,
        ledgerId: LedgerId.make("ledger:build-mode"),
        title: "Ship the parser",
        startState: "",
        checkpoints: [],
        winConditions: [],
        items: [
          { id: LedgerItemId.make("item-1"), title: "Write grammar", acceptance: "Tests pass" },
        ],
      });
      // The harness's orchestrator has its own settings without this loadout, so the choice is
      // recorded directly; the service under test reads the settings that define it.
      const created = yield* orchestrator.getThreadProjection(subjectId);
      const eventSink = yield* EventSink.EventSinkV2;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:build-mode:loadout"),
            type: "thread.metadata-updated",
            threadId: subjectId,
            providerInstanceId: codex,
            occurredAt: yield* DateTime.now,
            payload: {
              ...created.thread,
              loadout: { id: "judged", reason: null, setBy: "user" },
            },
          },
        ],
      });
      return yield* body({
        service: yield* BuildModeService.BuildModeService,
        orchestrator,
        threads: yield* ThreadManagementService.ThreadManagementService,
        controls,
      });
    }).pipe(Effect.provide(makeLayerTest(controls)));
  });

const request = { threadId: subjectId, creationSource: "web" as const };

it.effect("Build leaves plan mode and starts the build turn together", () =>
  withService(({ service, orchestrator }) =>
    Effect.gen(function* () {
      yield* service.build(request);
      const projection = yield* orchestrator.getThreadProjection(subjectId);
      expect(projection.thread.interactionMode).toBe("default");
      expect(projection.runs).toHaveLength(1);
    }),
  ),
);

it.effect("a build that cannot be dispatched puts the thread back in plan mode", () =>
  withService(({ service, orchestrator, controls }) =>
    Effect.gen(function* () {
      yield* Ref.set(controls.failBuildDispatch, true);
      const exit = yield* Effect.exit(service.build(request));
      expect(Exit.isFailure(exit)).toBe(true);
      const projection = yield* orchestrator.getThreadProjection(subjectId);
      expect(projection.thread.interactionMode).toBe("plan");
      expect(projection.runs).toEqual([]);
    }),
  ),
);

it.effect("every action is refused while the thread is working, and nothing changes", () =>
  withService(({ service, orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:build-mode:busy"),
        messageId: MessageId.make("message:build-mode:busy"),
        threadId: subjectId,
        text: "Still planning",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      for (const method of [
        service.build,
        service.compactAndBuild,
        service.resetAndBuild,
        service.audit,
      ]) {
        const exit = yield* Effect.exit(method(request));
        expect(exit).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [
              {
                error: { message: "The thread is working. Wait for its turn to end, then build." },
              },
            ],
          },
        });
      }
      const projection = yield* orchestrator.getThreadProjection(subjectId);
      expect(projection.thread.interactionMode).toBe("plan");
      expect(projection.runs).toHaveLength(1);
    }),
  ),
);

it.effect("an audit returns at once and its findings join the ledger when the judge ends", () =>
  withService(({ service, orchestrator, threads, controls }) =>
    Effect.gen(function* () {
      expect(yield* service.audit(request)).toEqual({ action: "audit" });
      // The judge is still running: nothing has been added yet.
      expect((yield* orchestrator.getThreadProjection(subjectId)).ledger?.items).toHaveLength(1);
      yield* Deferred.succeed(controls.releaseJudge, undefined);
      yield* orchestrator.streamStoredEvents.pipe(
        Stream.filter(
          ({ event }) => event.type === "ledger.item.added" && event.threadId === subjectId,
        ),
        Stream.runHead,
      );
      const items = (yield* orchestrator.getThreadProjection(subjectId)).ledger?.items ?? [];
      expect(items.map((item) => item.title)).toEqual([
        "Write grammar",
        "Audit: Plan skips the migration",
      ]);
      // The judge's hidden thread is archived once its answer is in.
      const { archivedThreads } = yield* threads.getShellSnapshot({ location: "archive" });
      expect(archivedThreads.some(({ id }) => id.startsWith("thread:audit:"))).toBe(true);
    }),
  ),
);

it.effect("the startup sweep archives audit threads a restart left behind", () =>
  withService(({ service, orchestrator, threads }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:build-mode:orphan"),
        threadId: ThreadId.make("thread:audit:left-behind"),
        projectId,
        title: "Plan audit",
        createdBy: "system",
        creationSource: "server",
        modelSelection: { instanceId: codex, model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: { parentThreadId: subjectId, relationshipToParent: "subagent" },
      });
      expect(yield* service.sweep()).toBe(1);
      expect(yield* service.sweep()).toBe(0);
      expect(
        (yield* threads.getThreadShell(ThreadId.make("thread:audit:left-behind")))?.archivedAt,
      ).not.toBeNull();
      // The thread being audited is not an audit thread and is left alone.
      expect((yield* threads.getThreadShell(subjectId))?.archivedAt ?? null).toBeNull();
    }),
  ),
);
