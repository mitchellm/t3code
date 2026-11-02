import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ThreadPullRequestLink,
  TurnItemId,
} from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const THREAD_ID = ThreadId.make("relay-thread");
const SECOND_THREAD_ID = ThreadId.make("relay-thread-2");
const PROJECT_ID = ProjectId.make("relay-project");
const NOW = "2026-09-04T12:00:00.000Z";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const PublishPayload = Schema.Struct({ state: Schema.NullOr(RelayAgentActivityState) });
const decodePublishPayload = Schema.decodeUnknownSync(Schema.fromJsonString(PublishPayload));
const unused = () => Effect.die("Unexpected test dependency call");

describe("startup agent activity", () => {
  it("publishes active work and only terminal runs completed after startup", () => {
    const startedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));
    const oldCompleted = ThreadId.make("old-completed");
    const newCompleted = ThreadId.make("new-completed");
    const oldFailed = ThreadId.make("old-failed");
    const newFailed = ThreadId.make("new-failed");
    const ids = AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: EnvironmentId.make("relay-env"),
      startedAt,
      projects: [{ id: PROJECT_ID, title: "Project" }],
      threads: [
        shell(),
        shell({
          id: oldCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({
          id: oldFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({ id: ThreadId.make("idle"), status: "idle" }),
        shell({ id: ThreadId.make("missing-project"), projectId: ProjectId.make("missing") }),
      ],
    });
    assert.deepStrictEqual(ids, [THREAD_ID, newCompleted, newFailed]);
  });
});

const makeTestRelay = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number) => Response;
    readonly failSecretRead?: (name: string) => boolean;
    readonly linked?: boolean;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
  } = {},
) {
  const values = new Map<string, Uint8Array>(
    options.linked === false
      ? []
      : [
          [PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true")],
          [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-1")],
        ],
  );
  const secretReads: string[] = [];
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.suspend(() => {
        secretReads.push(name);
        if (options.failSecretRead?.(name)) {
          return Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: name,
              cause: "temporary read failure",
            }),
          );
        }
        return Effect.succeed(Option.fromUndefinedOr(values.get(name)));
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: unused,
  });
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const shellReads: ThreadId[] = [];
  const projectReads: ProjectId[] = [];
  const catchUp = { shellSnapshotReads: 0 };
  const threads = ThreadManagementService.ThreadManagementService.of({
    getThreadShell: (threadId) =>
      Effect.sync(() => shellReads.push(threadId)).pipe(
        Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
      ),
    getShellSnapshot: () =>
      Effect.sync(() => {
        catchUp.shellSnapshotReads += 1;
        return { schemaVersion: 2, snapshotSequence: 1, threads: [], archivedThreads: [] };
      }),
    listActiveSubagentThreadIds: unused,
    countThreads: unused,
    listActiveShellIndex: () => Effect.succeed([]),
    listOlderSettledThreads: unused,
    readShellSnapshot: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: () => Effect.die("unused"),
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: () => Effect.die("unused"),
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused message count"),
    getTurnItem: () => Effect.die("unused turn item read"),
    getThreadRecords: () => Effect.die("unused record read"),
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: () => Effect.die("unused project record read"),
    listProjectThreads: unused,
    sendToThread: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    stopWorkflow: () => Effect.die("unused stopWorkflow"),
    forceStopThread: () => Effect.die("unused forceStopThread"),
    awaitBackgroundTasks: unused,
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: options.domainEvents ?? Stream.empty,
  });
  const publications: Array<{
    readonly url: string;
    readonly authorization: string | null;
    readonly state: RelayAgentActivityState | null;
  }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const body = init?.body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        return Promise.reject(new Error("Expected a serialized activity publish payload"));
      }
      const payload = decodePublishPayload(
        typeof body === "string" ? body : new TextDecoder().decode(body),
      );
      publications.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        state: payload.state,
      });
      return Promise.resolve(
        options.respond?.(publications.length) ?? Response.json({ ok: true, deliveries: [] }),
      );
    },
    { preconnect: () => {} },
  );
  const relay = yield* AgentAwarenessRelay.make.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("relay-environment")),
      getDescriptor: unused(),
    }),
    Effect.provideService(ProjectService.ProjectService, {
      create: unused,
      bootstrap: unused,
      update: unused,
      delete: unused,
      getByWorkspaceRoot: unused,
      snapshot: Effect.succeed({ projects: [] } as never),
      listPage: unused,
      getShell: unused,
      listShells: unused,
      getById: () =>
        Effect.sync(() => void projectReads.push(PROJECT_ID)).pipe(
          Effect.andThen(
            Effect.succeedSome({
              id: PROJECT_ID,
              title: "Project",
              workspaceRoot: "/workspace",
              defaultModelSelection: null,
              scripts: [],
              createdAt: NOW,
              updatedAt: NOW,
              deletedAt: null,
            }),
          ),
        ),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(NodeCrypto.layer),
  );
  return {
    relay,
    secrets,
    secretReads,
    currentShell,
    shellReads,
    projectReads,
    publications,
    catchUp,
  };
});

describe("AgentAwarenessRelay", () => {
  it.effect("coalesces queued updates and reruns a thread dirtied during publishing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const rerunStarted = yield* Deferred.make<void>();
      const releaseRerun = yield* Deferred.make<void>();
      const processed: Array<{ threadId: ThreadId; revision: number }> = [];
      let revision = 1;
      const worker = yield* AgentAwarenessRelay.makeAgentAwarenessPublishWorker((threadId) =>
        Effect.gen(function* () {
          const currentRevision = revision;
          const index = processed.length;
          processed.push({ threadId, revision: currentRevision });
          if (index === 0) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          } else if (threadId === THREAD_ID) {
            yield* Deferred.succeed(rerunStarted, undefined);
            yield* Deferred.await(releaseRerun);
          }
        }),
      );
      yield* worker.enqueue(THREAD_ID);
      yield* Deferred.await(started);
      revision = 2;
      for (let i = 0; i < 100; i++) {
        yield* worker.enqueue(SECOND_THREAD_ID);
        yield* worker.enqueue(THREAD_ID);
      }
      const drained = yield* Deferred.make<void>();
      const draining = yield* worker.drain.pipe(
        Effect.andThen(Deferred.succeed(drained, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(rerunStarted);
      assert.isFalse(yield* Deferred.isDone(drained));
      yield* Deferred.succeed(releaseRerun, undefined);
      yield* Fiber.join(draining);
      assert.deepEqual(processed, [
        { threadId: THREAD_ID, revision: 1 },
        { threadId: SECOND_THREAD_ID, revision: 2 },
        { threadId: THREAD_ID, revision: 2 },
      ]);
    }),
  );

  it.effect("deduplicates state and republishes title changes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T13:00:00Z") }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell({ title: "Renamed thread" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.threadTitle, "Renamed thread");
    }),
  );

  it.effect("republishes unchanged state with fresh credentials after relinking", () =>
    Effect.gen(function* () {
      const { relay, secrets, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* relay.requestCatchUp();
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[0]?.authorization, "Bearer credential-1");
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
      yield* secrets.set(
        RELAY_URL_SECRET,
        new TextEncoder().encode("https://new-relay.example.test"),
      );
      yield* relay.requestCatchUp();
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.isTrue(publications[2]?.url.startsWith("https://new-relay.example.test/") ?? false);
    }),
  );

  it.effect("reads the relay secrets once, not on every publish", () =>
    Effect.gen(function* () {
      const { relay, currentShell, secretReads } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const readsAfterFirst = secretReads.length;
      assert.isAbove(readsAfterFirst, 0);
      for (const hour of [13, 14, 15]) {
        yield* Ref.set(
          currentShell,
          shell({ updatedAt: DateTime.makeUnsafe(`2026-09-04T${hour}:00:00Z`) }),
        );
        yield* relay.publishThread(THREAD_ID);
      }
      assert.equal(secretReads.length, readsAfterFirst);
    }),
  );

  it.effect("picks up changed relay secrets after the cache window when nothing signals it", () =>
    Effect.gen(function* () {
      const { relay, secrets, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* TestClock.adjust("31 seconds");
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
    }),
  );

  it.effect(
    "stops publishing as soon as publication is switched off and catch-up is requested",
    () =>
      Effect.gen(function* () {
        const { relay, secrets, currentShell, publications } = yield* makeTestRelay();
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications.length, 1);
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
        yield* relay.requestCatchUp();
        yield* Ref.set(currentShell, shell({ title: "Renamed while off" }));
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications.length, 1);
      }),
  );

  it.effect("reads a subagent thread's shell once, not on every event", () =>
    Effect.gen(function* () {
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay();
      yield* Ref.set(
        currentShell,
        shell({
          lineage: {
            rootThreadId: SECOND_THREAD_ID,
            parentThreadId: SECOND_THREAD_ID,
            relationshipToParent: "subagent",
          },
        }),
      );
      for (let i = 0; i < 3; i++) {
        yield* relay.publishThread(THREAD_ID);
      }
      assert.equal(shellReads.length, 1);
      assert.equal(publications.length, 0);
    }),
  );

  it.effect("never reads the shell for a subagent thread created after startup", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, shellReads, publications } = yield* makeTestRelay({
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const now = yield* DateTime.now;
      yield* Queue.offer(events, {
        id: EventId.make("event:subagent:thread"),
        type: "thread.created",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "mcp",
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Subagent",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            rootThreadId: SECOND_THREAD_ID,
            parentThreadId: SECOND_THREAD_ID,
            relationshipToParent: "subagent",
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* Queue.take(pulls);
      yield* Queue.offer(events, {
        id: EventId.make("event:subagent:subagent-updated"),
        type: "subagent.updated",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {},
      } as unknown as OrchestrationV2DomainEvent);
      yield* Queue.take(pulls);
      yield* relay.drain;
      assert.equal(shellReads.length, 0);
      assert.equal(publications.length, 0);
    }).pipe(Effect.scoped),
  );

  describe("events that cannot move a published field", () => {
    const threadRecord = (overrides: Record<string, unknown> = {}) => ({
      createdBy: "user",
      creationSource: "web",
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      ...overrides,
    });

    // Publishes once so the relay has confirmed state, then hands back a way to feed one event at
    // a time and wait until the relay has handled it and drained its worker.
    const startPublishedRelay = Effect.fnUntraced(function* (initial?: OrchestrationV2ThreadShell) {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const test = yield* makeTestRelay({
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      if (initial !== undefined) yield* Ref.set(test.currentShell, initial);
      yield* test.relay.start();
      yield* Queue.take(pulls);
      yield* test.relay.publishThread(THREAD_ID);
      assert.equal(test.publications.length, 1);
      assert.equal(test.shellReads.length, 1);
      assert.equal(test.projectReads.length, 1);
      const emit = Effect.fnUntraced(function* (type: string, payload: unknown) {
        yield* Queue.offer(events, {
          id: EventId.make(`event:${type}:${yield* Queue.size(events)}`),
          type,
          threadId: THREAD_ID,
          occurredAt: yield* DateTime.now,
          payload,
        } as unknown as OrchestrationV2DomainEvent);
        yield* Queue.take(pulls);
        yield* test.relay.drain;
      });
      return { ...test, emit };
    });

    it.effect(
      "does no shell or project read and no publish when a thread event carries the same published fields",
      () =>
        Effect.gen(function* () {
          const { emit, shellReads, projectReads, publications, secretReads } =
            yield* startPublishedRelay();
          const secretReadsBefore = secretReads.length;
          yield* emit("thread.metadata-updated", threadRecord({ branch: "feature/new" }));
          yield* emit(
            "thread.pull-request-synced",
            threadRecord({ updatedAt: DateTime.makeUnsafe("2026-09-04T13:00:00Z") }),
          );
          assert.equal(shellReads.length, 1);
          assert.equal(projectReads.length, 1);
          assert.equal(publications.length, 1);
          assert.equal(secretReads.length, secretReadsBefore);
        }).pipe(Effect.scoped),
    );

    it.effect("reads and publishes when a thread event changes a published field", () =>
      Effect.gen(function* () {
        const { emit, currentShell, shellReads, projectReads, publications } =
          yield* startPublishedRelay();
        yield* Ref.set(currentShell, shell({ title: "Renamed thread" }));
        yield* emit("thread.metadata-updated", threadRecord({ title: "Renamed thread" }));
        assert.equal(shellReads.length, 2);
        assert.equal(projectReads.length, 2);
        assert.equal(publications.length, 2);
        assert.equal(publications[1]?.state?.threadTitle, "Renamed thread");
        // The rename is now the published baseline, so repeating it reads nothing.
        yield* emit("thread.metadata-updated", threadRecord({ title: "Renamed thread" }));
        assert.equal(shellReads.length, 2);
        assert.equal(publications.length, 2);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "reads when a pull request watch appears, since a watch holds a completion open",
      () =>
        Effect.gen(function* () {
          const { emit, shellReads } = yield* startPublishedRelay();
          yield* emit(
            "thread.pull-request-synced",
            threadRecord({
              pullRequests: [
                {
                  host: "github.com",
                  repository: "acme/widgets",
                  number: 7,
                  url: "https://github.com/acme/widgets/pull/7",
                  source: "manual",
                  watch: {},
                },
              ],
            }),
          );
          assert.equal(shellReads.length, 2);
        }).pipe(Effect.scoped),
    );

    it.effect("still reads for event types whose payload cannot show the card is unchanged", () =>
      Effect.gen(function* () {
        const { emit, shellReads, projectReads, publications } = yield* startPublishedRelay();
        yield* emit("run.updated", { id: RunId.make("run-1"), status: "running" });
        yield* emit("provider-thread.updated", { id: "provider-thread-1" });
        yield* emit("thread.pull-request-link-updated", { number: 7 });
        assert.equal(shellReads.length, 4);
        assert.equal(projectReads.length, 4);
        assert.equal(publications.length, 1);
      }).pipe(Effect.scoped),
    );

    const RUN_1 = RunId.make("run-1");
    const runRecord = (overrides: Record<string, unknown> = {}) => ({
      id: RUN_1,
      threadId: THREAD_ID,
      ordinal: 1,
      status: "running",
      queueHeld: false,
      requestedAt: DateTime.makeUnsafe(NOW),
      startedAt: DateTime.makeUnsafe(NOW),
      completedAt: null,
      ...overrides,
    });
    const runningShell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
      shell({ latestRunId: RUN_1, status: "running", activityRunStatus: "running", ...overrides });

    const REQUEST_1 = RuntimeRequestId.make("request-1");
    const requestRecord = (overrides: Record<string, unknown> = {}) => ({
      id: REQUEST_1,
      nodeId: "node-1",
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session-1" },
      createdAt: DateTime.makeUnsafe(NOW),
      resolvedAt: null,
      ...overrides,
    });
    const pendingRequest = (id = REQUEST_1) => ({
      id,
      kind: "command" as const,
      createdAt: DateTime.makeUnsafe(NOW),
      blocking: true,
    });

    const PROVIDER_THREAD_1 = ProviderThreadId.make("provider-thread-1");
    const backgroundTask = { taskId: "bg-1", kind: "background_task" as const };
    const providerThreadRecord = (
      tasks: ReadonlyArray<{ readonly taskId: string; readonly kind: string }>,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: PROVIDER_THREAD_1,
      appThreadId: THREAD_ID,
      status: "active",
      pendingBackgroundTasks: tasks,
      updatedAt: DateTime.makeUnsafe(NOW),
      ...overrides,
    });
    // A completed run holds the card at "running" while a background task is pending.
    const holdingShell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
      shell({
        status: "completed",
        activeProviderThreadId: PROVIDER_THREAD_1,
        pendingBackgroundTasks: [backgroundTask],
        ...overrides,
      });

    const pullRequestLink = (
      number: number,
      overrides: Partial<ThreadPullRequestLink> = {},
    ): ThreadPullRequestLink => ({
      host: "github.com",
      repository: "acme/widgets",
      number,
      url: `https://github.com/acme/widgets/pull/${number}`,
      source: "manual",
      linkedAt: NOW,
      snapshot: null,
      stack: null,
      watch: {
        startedAt: NOW,
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: NOW,
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
      ...overrides,
    });
    const watchTask = (number: number) => ({
      taskId: `pull-request-watch:github.com/acme/widgets#${number}`,
      description: `Watching pull request #${number}`,
      kind: "monitor" as const,
      awaited: true as const,
    });

    const costs = (test: {
      readonly shellReads: ReadonlyArray<unknown>;
      readonly projectReads: ReadonlyArray<unknown>;
      readonly publications: ReadonlyArray<unknown>;
      readonly secretReads: ReadonlyArray<unknown>;
    }) => ({
      shellReads: test.shellReads.length,
      projectReads: test.projectReads.length,
      publications: test.publications.length,
      secretReads: test.secretReads.length,
    });
    const afterOneRead = (idle: ReturnType<typeof costs>, publishes = 0) => ({
      ...idle,
      shellReads: idle.shellReads + 1,
      projectReads: idle.projectReads + 1,
      publications: idle.publications + publishes,
    });

    it.effect(
      "run events: does no read and no publish when the run and its status match the published card",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(runningShell());
          const idle = costs(test);
          yield* test.emit("run.updated", runRecord());
          yield* test.emit(
            "run.updated",
            runRecord({ workStartedAt: DateTime.makeUnsafe("2026-09-04T12:00:05Z") }),
          );
          assert.deepEqual(costs(test), idle);
        }).pipe(Effect.scoped),
    );

    it.effect("run events: a new run or a finished run still reads and publishes", () =>
      Effect.gen(function* () {
        const test = yield* startPublishedRelay(runningShell());
        const idle = costs(test);
        const run2 = RunId.make("run-2");
        yield* Ref.set(test.currentShell, runningShell({ latestRunId: run2 }));
        yield* test.emit("run.created", runRecord({ id: run2, ordinal: 2 }));
        assert.deepEqual(costs(test), afterOneRead(idle));
        // The new run is now the published baseline, so repeating it reads nothing.
        yield* test.emit("run.updated", runRecord({ id: run2, ordinal: 2 }));
        assert.deepEqual(costs(test), afterOneRead(idle));

        yield* Ref.set(
          test.currentShell,
          shell({ latestRunId: run2, status: "completed", activityRunStatus: null }),
        );
        yield* test.emit("run.updated", runRecord({ id: run2, ordinal: 2, status: "completed" }));
        assert.equal(test.shellReads.length, idle.shellReads + 2);
        yield* TestClock.adjust("5 seconds");
        yield* test.relay.drain;
        assert.deepEqual(
          test.publications.map((publication) => publication.state?.phase),
          ["running", "completed"],
        );
      }).pipe(Effect.scoped),
    );

    it.effect("run events: a held queued run is never taken for the published one", () =>
      Effect.gen(function* () {
        const test = yield* startPublishedRelay(runningShell());
        const idle = costs(test);
        yield* test.emit("run.updated", runRecord({ queueHeld: true }));
        assert.deepEqual(costs(test), afterOneRead(idle));
      }).pipe(Effect.scoped),
    );

    it.effect(
      "runtime-request events: does no read and no publish when the pending request is already published",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(
            runningShell({ pendingRuntimeRequest: pendingRequest() }),
          );
          assert.equal(test.publications[0]?.state?.phase, "waiting_for_approval");
          const idle = costs(test);
          yield* test.emit("runtime-request.updated", requestRecord());
          // A request that was never the pending one cannot move the card when it resolves.
          yield* test.emit(
            "runtime-request.updated",
            requestRecord({
              id: RuntimeRequestId.make("request-2"),
              status: "resolved",
              resolvedAt: DateTime.makeUnsafe(NOW),
            }),
          );
          assert.deepEqual(costs(test), idle);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "runtime-request events: a request that opens or resolves still reads and publishes",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(runningShell());
          const idle = costs(test);
          yield* Ref.set(
            test.currentShell,
            runningShell({ pendingRuntimeRequest: pendingRequest() }),
          );
          yield* test.emit("runtime-request.updated", requestRecord());
          assert.deepEqual(costs(test), afterOneRead(idle, 1));
          assert.equal(test.publications[1]?.state?.phase, "waiting_for_approval");
          yield* test.emit("runtime-request.updated", requestRecord());
          assert.deepEqual(costs(test), afterOneRead(idle, 1));

          yield* Ref.set(test.currentShell, runningShell());
          yield* test.emit(
            "runtime-request.updated",
            requestRecord({ status: "resolved", resolvedAt: DateTime.makeUnsafe(NOW) }),
          );
          assert.equal(test.shellReads.length, idle.shellReads + 2);
          assert.equal(test.publications[2]?.state?.phase, "running");
          yield* test.emit(
            "runtime-request.updated",
            requestRecord({ status: "resolved", resolvedAt: DateTime.makeUnsafe(NOW) }),
          );
          assert.equal(test.shellReads.length, idle.shellReads + 2);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "provider-thread events: does no read and no publish when the pending task set is unchanged",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(holdingShell());
          assert.equal(test.publications[0]?.state?.phase, "running");
          const idle = costs(test);
          // Nothing in the relay has seen this provider thread's tasks yet, so the first event reads.
          yield* test.emit("provider-thread.updated", providerThreadRecord([backgroundTask]));
          assert.deepEqual(costs(test), afterOneRead(idle));
          yield* test.emit(
            "provider-thread.updated",
            providerThreadRecord([backgroundTask], {
              updatedAt: DateTime.makeUnsafe("2026-09-04T12:05:00Z"),
            }),
          );
          yield* test.emit(
            "provider-thread.updated",
            providerThreadRecord([backgroundTask], { status: "idle" }),
          );
          assert.deepEqual(costs(test), afterOneRead(idle));
        }).pipe(Effect.scoped),
    );

    it.effect(
      "provider-thread events: a task that clears or appears still reads and publishes",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(holdingShell());
          const idle = costs(test);
          yield* test.emit("provider-thread.updated", providerThreadRecord([backgroundTask]));
          yield* Ref.set(test.currentShell, holdingShell({ pendingBackgroundTasks: [] }));
          yield* test.emit("provider-thread.updated", providerThreadRecord([]));
          assert.equal(test.shellReads.length, idle.shellReads + 2);
          yield* TestClock.adjust("5 seconds");
          yield* test.relay.drain;
          assert.deepEqual(
            test.publications.map((publication) => publication.state?.phase),
            ["running", "completed"],
          );

          const second = { taskId: "bg-2", kind: "background_task" as const };
          yield* Ref.set(test.currentShell, holdingShell({ pendingBackgroundTasks: [second] }));
          yield* test.emit("provider-thread.updated", providerThreadRecord([second]));
          // The held completion's confirmation read once more after its five seconds.
          assert.equal(test.shellReads.length, idle.shellReads + 4);
          assert.deepEqual(
            test.publications.map((publication) => publication.state?.phase),
            ["running", "completed", "running"],
          );
        }).pipe(Effect.scoped),
    );

    it.effect(
      "provider-thread events: a provider thread that is not the active one still reads",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(holdingShell());
          const idle = costs(test);
          yield* test.emit("provider-thread.updated", providerThreadRecord([backgroundTask]));
          yield* test.emit(
            "provider-thread.updated",
            providerThreadRecord([backgroundTask], {
              id: ProviderThreadId.make("provider-thread-2"),
            }),
          );
          assert.equal(test.shellReads.length, idle.shellReads + 2);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "pull-request-link events: does no read and no publish when the link's watch state is already published",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(
            holdingShell({
              pullRequests: [pullRequestLink(7)],
              pendingBackgroundTasks: [watchTask(7)],
            }),
          );
          assert.equal(test.publications[0]?.state?.phase, "running");
          const idle = costs(test);
          yield* test.emit(
            "thread.pull-request-link-updated",
            pullRequestLink(7, { linkedAt: "2026-09-04T12:30:00.000Z" }),
          );
          // A dismissed link that was never watched cannot hold a completion open.
          yield* test.emit(
            "thread.pull-request-link-updated",
            pullRequestLink(8, { source: "stack-dismissed" }),
          );
          assert.deepEqual(costs(test), idle);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "pull-request-link events: a watch that appears or ends still reads and publishes",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(
            holdingShell({
              pullRequests: [pullRequestLink(7)],
              pendingBackgroundTasks: [watchTask(7)],
            }),
          );
          const idle = costs(test);
          yield* test.emit("thread.pull-request-link-updated", pullRequestLink(9));
          assert.deepEqual(costs(test), afterOneRead(idle));

          const dismissed = pullRequestLink(7, { source: "stack-dismissed" });
          yield* Ref.set(
            test.currentShell,
            holdingShell({ pullRequests: [dismissed], pendingBackgroundTasks: [] }),
          );
          yield* test.emit("thread.pull-request-link-updated", dismissed);
          assert.equal(test.shellReads.length, idle.shellReads + 2);
          yield* TestClock.adjust("5 seconds");
          yield* test.relay.drain;
          assert.deepEqual(
            test.publications.map((publication) => publication.state?.phase),
            ["running", "completed"],
          );
        }).pipe(Effect.scoped),
    );

    it.effect(
      "thread events: settled, model and provider switches that carry the published fields do no read",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay();
          const idle = costs(test);
          yield* test.emit("thread.settled", threadRecord());
          yield* test.emit("thread.model-selection-updated", threadRecord());
          yield* test.emit("thread.provider-switched", threadRecord());
          assert.deepEqual(costs(test), idle);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "thread events: a model switch or a settle that moves a published field still reads",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay();
          const idle = costs(test);
          yield* Ref.set(
            test.currentShell,
            shell({
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "other" },
            }),
          );
          yield* test.emit(
            "thread.model-selection-updated",
            threadRecord({
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "other" },
            }),
          );
          assert.deepEqual(costs(test), afterOneRead(idle, 1));
          assert.equal(test.publications[1]?.state?.modelTitle, "other");
          yield* test.emit("thread.settled", threadRecord({ settledOverride: "settled" }));
          assert.equal(test.shellReads.length, idle.shellReads + 2);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "subagent.updated does no read: no published field comes from a subagent record",
      () =>
        Effect.gen(function* () {
          const test = yield* startPublishedRelay(holdingShell());
          const idle = costs(test);
          yield* test.emit("subagent.updated", {
            id: "node-1",
            threadId: THREAD_ID,
            status: "completed",
            childThreadId: SECOND_THREAD_ID,
          });
          yield* test.emit("subagent.updated", {
            id: "node-1",
            threadId: THREAD_ID,
            status: "running",
            childThreadId: SECOND_THREAD_ID,
          });
          assert.deepEqual(costs(test), idle);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "reads an event that arrives while a publish is reading, not the stale baseline",
      () =>
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
          const pulls = yield* Queue.unbounded<void>();
          const live = yield* Ref.make(shell());
          const readStarted = yield* Deferred.make<void>();
          const releaseRead = yield* Deferred.make<void>();
          let blockNextRead = false;
          const test = yield* makeTestRelay({
            readShell: () =>
              Effect.gen(function* () {
                const snapshot = yield* Ref.get(live);
                if (blockNextRead) {
                  blockNextRead = false;
                  yield* Deferred.succeed(readStarted, undefined);
                  yield* Deferred.await(releaseRead);
                }
                return snapshot;
              }),
            domainEvents: Stream.fromEffectRepeat(
              Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
            ),
          });
          yield* test.relay.start();
          yield* Queue.take(pulls);
          yield* test.relay.publishThread(THREAD_ID);
          const offer = Effect.fnUntraced(function* (id: string, title: string) {
            yield* Queue.offer(events, {
              id: EventId.make(id),
              type: "thread.metadata-updated",
              threadId: THREAD_ID,
              occurredAt: yield* DateTime.now,
              payload: threadRecord({ title }),
            } as unknown as OrchestrationV2DomainEvent);
            yield* Queue.take(pulls);
          });

          yield* Ref.set(live, shell({ title: "Renamed thread" }));
          blockNextRead = true;
          yield* offer("event:rename", "Renamed thread");
          yield* Deferred.await(readStarted);
          // The rename is being published; renaming back matches the baseline from before it.
          yield* Ref.set(live, shell({ title: "Thread" }));
          yield* offer("event:rename-back", "Thread");
          yield* Deferred.succeed(releaseRead, undefined);
          yield* test.relay.drain;
          assert.deepEqual(
            test.publications.map((publication) => publication.state?.threadTitle),
            ["Thread", "Renamed thread", "Thread"],
          );
        }).pipe(Effect.scoped),
    );

    it.effect("reads again after the relay link is reset", () =>
      Effect.gen(function* () {
        const { emit, relay, secrets, shellReads } = yield* startPublishedRelay();
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
        yield* relay.requestCatchUp();
        yield* relay.publishThread(THREAD_ID);
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
        yield* relay.requestCatchUp();
        yield* emit("thread.metadata-updated", threadRecord({ branch: "feature/new" }));
        assert.equal(shellReads.length, 2);
      }).pipe(Effect.scoped),
    );
  });

  it.effect.each(["completed", "failed"] as const)(
    "publishes a tombstone when a %s thread is settled through a domain event",
    (status) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const pulls = yield* Queue.unbounded<void>();
        const { relay, currentShell, publications } = yield* makeTestRelay({
          domainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        });
        yield* relay.start();
        yield* Queue.take(pulls);
        yield* relay.publishThread(THREAD_ID);
        const terminal = shell({ status });
        yield* Ref.set(currentShell, terminal);
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications[1]?.state?.phase, status);

        const now = yield* DateTime.now;
        const settled = {
          ...terminal,
          settledOverride: "settled" as const,
          settledAt: now,
          lastVisitedAt: null,
        };
        yield* Ref.set(currentShell, settled);
        yield* Queue.offer(events, {
          id: EventId.make("event:settled"),
          type: "thread.settled",
          threadId: THREAD_ID,
          occurredAt: now,
          payload: settled,
        });
        yield* Queue.take(pulls);
        yield* relay.drain;
        assert.equal(publications.length, 2);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 3);
        assert.equal(publications[2]?.state, null);
      }).pipe(Effect.scoped),
  );

  it.effect("holds a completion through a continuation gap, then publishes it once", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell());
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }),
  );

  it.effect("still publishes a completion when the thread settles during the hold", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );
    }),
  );

  it.effect("drops a held completion when a queued continuation hides the thread", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "queued" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.notInclude(
        publications.map((publication) => publication.state?.phase ?? null),
        "completed",
      );
    }),
  );

  it.effect("retries a failed completion even after the thread settles", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 2
            ? new Response("unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state ?? null, null);
    }),
  );

  it.effect("keeps settled live work until its awaited monitor finishes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const held = shell({
        status: "completed",
        settledOverride: "settled",
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
      });
      yield* Ref.set(currentShell, held);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "running");

      yield* Ref.set(currentShell, { ...held, pendingBackgroundTasks: [] });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state, null);
    }),
  );
  it.effect("publishes a held completion when its background item ends, not on tool output", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, shellReads, publications } = yield* makeTestRelay({
        readShell: (threadId) => store.getThreadShell(threadId).pipe(Effect.orDie),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const deliver = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
        yield* store.apply(event);
        yield* Queue.offer(events, event);
        yield* Queue.take(pulls);
        yield* relay.drain;
      });

      const now = yield* DateTime.now;
      const runId = RunId.make("run:held-item");
      const run = {
        id: runId,
        threadId: THREAD_ID,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:held-item"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const item = (
        id: string,
        fields: Pick<OrchestrationV2TurnItem, "status"> &
          (
            | { readonly type: "dynamic_tool"; readonly toolName: string; readonly input: unknown }
            | {
                readonly type: "assistant_message";
                readonly messageId: MessageId;
                readonly text: string;
                readonly streaming: boolean;
              }
          ),
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: THREAD_ID,
        runId,
        nodeId: NodeId.make("node:held-item"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        ...fields,
      });
      const itemEvent = (id: string, payload: OrchestrationV2TurnItem) =>
        ({
          id: EventId.make(id),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          runId,
          occurredAt: now,
          payload,
        }) satisfies OrchestrationV2DomainEvent;
      const background = { type: "dynamic_tool" as const, toolName: "watch", input: {} };

      yield* deliver({
        id: EventId.make("event:held-item:thread"),
        type: "thread.created",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* deliver({
        id: EventId.make("event:held-item:run"),
        type: "run.created",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: run,
      });
      yield* deliver(
        itemEvent("event:held-item:tool", item("item:tool", { ...background, status: "running" })),
      );
      yield* deliver({
        id: EventId.make("event:held-item:run-completed"),
        type: "run.updated",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      const readsBeforeOutput = shellReads.length;
      yield* deliver(
        itemEvent(
          "event:held-item:reply",
          item("item:reply", {
            type: "assistant_message",
            messageId: MessageId.make("message:held-item:reply"),
            text: "Still watching",
            streaming: true,
            status: "running",
          }),
        ),
      );
      yield* deliver(
        itemEvent("event:held-item:tick", item("item:tool", { ...background, status: "running" })),
      );
      assert.equal(shellReads.length, readsBeforeOutput);

      yield* deliver(
        itemEvent("event:held-item:end", item("item:tool", { ...background, status: "completed" })),
      );
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
});

it.effect("catches up after startup without polling after success", () =>
  Effect.gen(function* () {
    const { relay, secrets, secretReads, catchUp } = yield* makeTestRelay();
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 1);

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 1);

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 2);

    const readsBeforeIdle = secretReads.length;
    yield* TestClock.adjust("10 minutes");
    assert.equal(catchUp.shellSnapshotReads, 2);
    assert.equal(secretReads.length, readsBeforeIdle);

    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 3);
  }).pipe(Effect.scoped),
);
