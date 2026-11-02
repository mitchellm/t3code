import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

const makeFinalizationLayer = (input: {
  readonly scopeId: CheckpointScopeId;
  readonly runId: RunId;
  readonly captured: string[];
  readonly refresh: () => Effect.Effect<void, RunFinalization.RunFinalizationRefreshError>;
}) =>
  RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              input.captured.push("checkpoint");
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [
                { id: input.scopeId, runId: input.runId, kind: "root_run" as const, cwd: "/repo" },
              ],
              checkpoints: [],
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: input.refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
  const threadId = ThreadId.make("thread_refresh_failure");
  const runId = RunId.make("run_refresh_failure");
  const scopeId = CheckpointScopeId.make("scope_refresh_failure");
  const captured: string[] = [];
  return Effect.gen(function* () {
    const refreshFinished = yield* Deferred.make<void>();
    const layer = makeFinalizationLayer({
      scopeId,
      runId,
      captured,
      refresh: () =>
        Effect.gen(function* () {
          captured.push("refresh");
          return yield* new RunFinalization.RunFinalizationRefreshError({
            cwd: "/repo",
            cause: new Error("Git command timed out"),
          });
        }).pipe(Effect.ensuring(Deferred.succeed(refreshFinished, undefined))),
    });
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize({ threadId, runId, scopeId });
      yield* Deferred.await(refreshFinished);
      assert.deepEqual(captured, ["checkpoint", "refresh"]);
    }).pipe(Effect.provide(layer));
  });
});

it.effect(
  "finalize returns once the checkpoint is captured without waiting for the refresh",
  () => {
    const threadId = ThreadId.make("thread_refresh_slow");
    const runId = RunId.make("run_refresh_slow");
    const scopeId = CheckpointScopeId.make("scope_refresh_slow");
    const captured: string[] = [];
    return Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const refreshDone = yield* Deferred.make<void>();
      const layer = makeFinalizationLayer({
        scopeId,
        runId,
        captured,
        refresh: () =>
          Deferred.succeed(refreshStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRefresh)),
            Effect.andThen(
              Effect.sync(() => {
                captured.push("refresh");
              }),
            ),
            Effect.andThen(Deferred.succeed(refreshDone, undefined)),
            Effect.asVoid,
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* RunFinalization.RunFinalizationService;
        // The refresh stays blocked on `releaseRefresh`, so this only returns if finalize does not wait for it.
        yield* service.finalize({ threadId, runId, scopeId });
        assert.deepEqual(captured, ["checkpoint"]);
        yield* Deferred.await(refreshStarted);
        yield* Deferred.succeed(releaseRefresh, undefined);
        yield* Deferred.await(refreshDone);
        assert.deepEqual(captured, ["checkpoint", "refresh"]);
      }).pipe(Effect.provide(layer));
    });
  },
);

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});
