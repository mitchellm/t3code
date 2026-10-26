// Fork: `message.dispatch` with `freshProviderThread` starts a new native conversation on the same
// app thread, the path Reset and build relies on.
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const threadId = ThreadId.make("thread:fresh-provider-thread");
const projectId = ProjectId.make("project:fresh-provider-thread");

interface CapturedTurn {
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadId: string | null;
  readonly providerSessionId: ProviderSessionId;
  readonly text: string;
}

function makeAdapter(input: {
  readonly selection: typeof CLAUDE_MODEL_SELECTION;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly captured: Ref.Ref<ReadonlyArray<CapturedTurn>>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const driver = ProviderDriverKind.make(
    input.capabilities === ClaudeProviderCapabilitiesV2 ? "claudeAgent" : "codex",
  );
  let nativeThreads = 0;
  return {
    instanceId: input.selection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: input.selection.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.selection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const unused = (detail: string) =>
          Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: input.selection.instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              nativeThreads += 1;
              const nativeId = `${driver}:native:${nativeThreads}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeId}`),
                driver,
                providerInstanceId: input.selection.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.captured, (turns) => [
                ...turns,
                {
                  providerThreadId: turnInput.providerThread.id,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  providerSessionId: sessionInput.providerSessionId,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: null,
                  ordinal: turnInput.runOrdinal,
                  status: "completed",
                  startedAt: eventTime,
                  completedAt: eventTime,
                },
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: () => unused("rollbackThread"),
          forkThread: () => unused("forkThread"),
        };
        return runtime;
      }),
  };
}

const runScenario = (
  name: string,
  selection: typeof CLAUDE_MODEL_SELECTION,
  capabilities: OrchestrationV2ProviderCapabilities,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(`fresh-provider-thread-${name}`);
    const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
    const registry = ProviderAdapterRegistry.layerFromAdapters([
      makeAdapter({ selection, capabilities, captured }),
    ]);
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const completed = (ordinal: number) =>
        orchestrator.streamStoredEvents.pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.ordinal === ordinal &&
              event.payload.status === "completed",
          ),
          Stream.runHead,
          Effect.andThen(worker.drain()),
        );
      const send = (ordinal: number, fresh: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`fresh:${ordinal}`),
          messageId: MessageId.make(`fresh:${ordinal}`),
          threadId,
          createdBy: "user",
          creationSource: "web",
          text: `Turn ${ordinal}`,
          attachments: [],
          ...(fresh ? { freshProviderThread: true as const } : {}),
          dispatchMode: { type: "start_immediately" },
        });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("fresh:create"),
        threadId,
        projectId,
        createdBy: "user",
        creationSource: "web",
        title: "Fresh provider thread",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* send(1, false);
      yield* completed(1);
      yield* send(2, false);
      yield* completed(2);
      yield* send(3, true);
      yield* completed(3);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const events = yield* orchestrator.streamStoredEvents.pipe(
        Stream.takeUntil(
          ({ event }) => event.type === "run.updated" && event.payload.ordinal === 3,
        ),
        Stream.runCollect,
      );
      return { projection, turns: yield* Ref.get(captured), events };
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          {
            name: `fresh-provider-thread-${name}`,
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly" },
            },
          },
          registry,
        ),
      ),
    );
  });

describe("freshProviderThread", () => {
  it.live("starts a new native thread on the same instance and leaves the old one in place", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projection, turns } = yield* runScenario(
          "claude",
          CLAUDE_MODEL_SELECTION,
          ClaudeProviderCapabilitiesV2,
        );
        assert.deepEqual(
          turns.map((turn) => turn.text),
          ["Turn 1", "Turn 2", "Turn 3"],
        );
        // Turns 1 and 2 share a native conversation; turn 3 is the first of a new one.
        assert.equal(turns[0]!.nativeThreadId, turns[1]!.nativeThreadId);
        assert.notEqual(turns[2]!.nativeThreadId, turns[1]!.nativeThreadId);
        assert.notEqual(turns[2]!.providerThreadId, turns[1]!.providerThreadId);
        // Claude holds one native thread per session, so the new thread gets its own session.
        assert.notEqual(turns[2]!.providerSessionId, turns[1]!.providerSessionId);
        assert.equal(projection.thread.activeProviderThreadId, turns[2]!.providerThreadId);
        assert.equal(projection.providerThreads.length, 2);
        assert.deepEqual(
          projection.messages.filter((message) => message.role === "user").map((m) => m.text),
          ["Turn 1", "Turn 2", "Turn 3"],
        );
      }),
    ),
  );

  it.live("keeps a shared session when the provider runs many threads per session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { turns } = yield* runScenario(
          "codex",
          CODEX_MODEL_SELECTION,
          CodexProviderCapabilitiesV2,
        );
        assert.notEqual(turns[2]!.nativeThreadId, turns[1]!.nativeThreadId);
        assert.equal(turns[2]!.providerSessionId, turns[1]!.providerSessionId);
      }),
    ),
  );

  it.live("detaches the session the old thread no longer needs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { turns, events } = yield* runScenario(
          "detach",
          CLAUDE_MODEL_SELECTION,
          ClaudeProviderCapabilitiesV2,
        );
        const detached = events.flatMap(({ event }) =>
          event.type === "provider-session.detached" ? [event.payload.providerSessionId] : [],
        );
        assert.deepEqual(detached, [turns[1]!.providerSessionId]);
      }),
    ),
  );

  it.live("refuses to queue or steer a fresh start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("fresh-provider-thread-refuse");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeAdapter({
            selection: CLAUDE_MODEL_SELECTION,
            capabilities: ClaudeProviderCapabilitiesV2,
            captured,
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("refuse:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Fresh provider thread",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          const refused = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("refuse:queued"),
              messageId: MessageId.make("refuse:queued"),
              threadId,
              createdBy: "user",
              creationSource: "web",
              text: "Queued fresh",
              attachments: [],
              freshProviderThread: true,
              dispatchMode: { type: "queue_after_active" },
            })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "OrchestratorDispatchError");
          assert.include(String("cause" in refused ? refused.cause : ""), "fresh provider thread");
          assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runs, []);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "fresh-provider-thread-refuse",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              registry,
            ),
          ),
        );
      }),
    ),
  );
});
