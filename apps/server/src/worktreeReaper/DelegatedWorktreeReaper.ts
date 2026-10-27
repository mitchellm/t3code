// Fork: removes the worktrees T3 made for delegated child threads once the work is safe to lose.
// Upstream's storageCleanup owns the user-configured rules (age, merge, delete) for every thread;
// this adds the one rule delegation needs, "a finished worker's checkout is disposable", and
// reuses its eligibility helpers, its managed-path test and the same linked-worktree removal.
import {
  OrchestrationV2ProviderSessionJson,
  type OrchestrationV2ThreadShell,
  type WorktreeKeepWhen,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "../storageCleanup.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { removeLinkedWorktree } from "../vcs/worktreeRemoval.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";

/** A finished child may still be inspected or resumed shortly after it completes. */
export const DELEGATED_WORKTREE_GRACE_MS = 24 * 60 * 60 * 1_000;
const REAP_INTERVAL = "1 hour";
// An interrupted child stopped for good unless someone resumes it, which the re-check catches.
const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

export type ReapOutcome = "removed" | "would_remove" | "kept" | "failed";
export interface ReapEntry {
  readonly path: string;
  readonly threadId: string;
  readonly outcome: ReapOutcome;
  readonly reason: string;
}
export type ReapReport = ReadonlyArray<ReapEntry>;

export class DelegatedWorktreeReaper extends Context.Service<
  DelegatedWorktreeReaper,
  {
    /** `dryRun` is the preview: it classifies every worktree and removes nothing. */
    readonly reap: (options?: { readonly dryRun?: boolean }) => Effect.Effect<ReapReport>;
  }
>()("t3/worktreeReaper/DelegatedWorktreeReaper") {}

const isDelegatedChild = (thread: OrchestrationV2ThreadShell) =>
  thread.lineage.relationshipToParent === "subagent" &&
  thread.createdBy === "agent" &&
  thread.worktreePath !== null;

const isFinishedAndIdle = (thread: OrchestrationV2ThreadShell, now: number) =>
  FINISHED_STATUSES.has(thread.status) && storageCleanupThreadIdle(thread, now);

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const gitManager = yield* GitManager.GitManager;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isWindows = yield* HostProcess.isWindows;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  const gitLines = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "DelegatedWorktreeReaper.git", cwd, args, maxOutputBytes: 256 * 1024 })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== ""),
        ),
      );

  /**
   * Null when nothing would be lost by deleting the checkout, otherwise why it must stay.
   * Ignored files (.env, build output) are removed with the worktree, as upstream's default
   * does; `worktreeKeepWhen` can protect them or relax the untracked-file check.
   */
  const lossReason = Effect.fn("DelegatedWorktreeReaper.lossReason")(function* (
    cwd: string,
    branch: string,
    keepWhen: WorktreeKeepWhen,
  ) {
    const current = yield* gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
      Effect.orElseSucceed(() => [] as string[]),
    );
    if (current[0] !== branch) return "its branch changed since the thread started";
    const changes = yield* gitLines(cwd, [
      "status",
      "--porcelain=v1",
      keepWhen === "tracked-changes" ? "--untracked-files=no" : "--untracked-files=all",
    ]);
    if (changes.length > 0) return `has uncommitted changes (${changes.length} files)`;
    if (keepWhen === "any-local-files") {
      const ignored = yield* gitLines(cwd, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ]);
      const file = ignored.find((entry) => !/(^|\/)node_modules\/$/.test(entry));
      if (file !== undefined) return `has ignored files (${file})`;
    }
    // Contained in another local branch means merged; contained in a remote ref means pushed.
    const [local, remote] = yield* Effect.all([
      gitLines(cwd, ["branch", "--contains", "HEAD", "--format=%(refname:short)"]),
      gitLines(cwd, ["branch", "--remotes", "--contains", "HEAD", "--format=%(refname:short)"]),
    ]);
    if (local.some((name) => name !== branch) || remote.length > 0) return null;
    return "has commits that are not merged or pushed";
  });

  /**
   * Re-read the group after the first snapshot, under the workspace lease: a child that resumed
   * since then, or a session still open on the path, must stop the removal.
   */
  const blockedSinceSnapshot = Effect.fn("DelegatedWorktreeReaper.blockedSinceSnapshot")(function* (
    worktreePath: string,
    group: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const latestPaths = (yield* projections.getThreadWorktreePaths({
      includeArchived: true,
    })).filter((entry) => pathKey(entry.worktreePath) === pathKey(worktreePath));
    const latest = (yield* Effect.forEach(latestPaths, (entry) =>
      projections.getThreadShell(entry.threadId),
    )).filter((shell) => shell !== null);
    const changed =
      latest.length !== group.length ||
      latest.some((shell) => {
        const before = group.find((member) => member.id === shell.id);
        return (
          before === undefined ||
          !isDelegatedChild(shell) ||
          !isFinishedAndIdle(shell, now) ||
          shell.branch !== before.branch ||
          pathKey(shell.worktreePath!) !== pathKey(worktreePath) ||
          storageCleanupActivityAt(shell) !== storageCleanupActivityAt(before) ||
          now - storageCleanupActivityAt(shell) < DELEGATED_WORKTREE_GRACE_MS
        );
      });
    if (changed) return "thread activity or shared worktree changed since check";
    // Sessions can outlive their run, and only a live one protects its working directory.
    const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_provider_sessions
        WHERE status != 'stopped'
      `.pipe(NodeSqliteClient.readOnly);
    for (const row of rows) {
      const session = yield* decodeSession(row.payload_json);
      const cwd = path.resolve(session.cwd);
      if (
        (pathKey(cwd) === pathKey(worktreePath) || inside(worktreePath, cwd)) &&
        (yield* providerSessions.isLive(session.id))
      )
        return "provider session is still open";
    }
    return null;
  });

  const reap = Effect.fn("DelegatedWorktreeReaper.reap")(function* (options?: {
    readonly dryRun?: boolean;
  }) {
    const dryRun = options?.dryRun === true;
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const snapshot = yield* projections.getShellSnapshot();
    const projectShells = yield* projectStore.listShells();
    const byPath = Map.groupBy(
      [...snapshot.threads, ...snapshot.archivedThreads].filter(
        (thread) => thread.worktreePath !== null && thread.deletedAt === null,
      ),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const report: ReapEntry[] = [];

    for (const [worktreePath, group] of byPath) {
      const delegated = group.filter(isDelegatedChild);
      // Only a worktree a delegated child owns is ours to judge; a user's own thread never is.
      if (delegated.length === 0) continue;
      const thread = delegated[0]!;
      const entry = (outcome: ReapOutcome, reason: string) =>
        report.push({ path: worktreePath, threadId: thread.id, outcome, reason });
      const keep = (reason: string) => entry("kept", reason);
      const keepWhen = resolveWorktreeCleanup(settings, thread.projectId).worktreeKeepWhen;

      yield* Effect.gen(function* () {
        if (delegated.length !== group.length)
          return keep("shared with a thread that was not delegated");
        if (!group.every((member) => isFinishedAndIdle(member, now)))
          return keep("a child thread is still running or has pending work");
        const idleFor = now - Math.max(...group.map(storageCleanupActivityAt));
        if (idleFor < DELEGATED_WORKTREE_GRACE_MS)
          return keep("finished inside the 24 hour grace period");
        if (!(yield* fs.exists(worktreePath))) return;

        // Ownership: a real linked worktree at <managed root>/<repo>/<name>, never a project
        // checkout or one another tool made (Claude Code's .claude/worktrees is outside it).
        const realPath = yield* fs.realPath(worktreePath);
        const realParent = yield* fs.realPath(path.dirname(worktreePath));
        const project = projectShells.find((candidate) => candidate.id === thread.projectId);
        const isProjectCheckout = projectShells.some(
          (candidate) =>
            pathKey(candidate.workspaceRoot) === pathKey(realPath) ||
            inside(realPath, candidate.workspaceRoot),
        );
        const linked =
          (yield* fs.stat(path.join(worktreePath, ".git")).pipe(Effect.orElseSucceed(() => null)))
            ?.type === "File";
        if (
          project === undefined ||
          isProjectCheckout ||
          !linked ||
          realPath !== path.join(realParent, path.basename(worktreePath)) ||
          !(yield* isManagedWorktreePath(worktreePath))
        )
          return keep("not created by T3 for a delegated task");
        if (thread.branch === null) return keep("its thread has no recorded branch");
        const branch = thread.branch;

        const loss = yield* lossReason(worktreePath, branch, keepWhen);
        if (loss !== null) return keep(loss);
        if (dryRun) return entry("would_remove", "finished, clean, and merged or pushed");

        const blocked = yield* withWorkspaceLease(
          worktreePath,
          Effect.gen(function* () {
            const reason = yield* blockedSinceSnapshot(worktreePath, group);
            if (reason !== null) return reason;
            // The checks above ran before the lease, so run the git ones again under it.
            const lateLoss = yield* lossReason(worktreePath, branch, keepWhen);
            if (lateLoss !== null) return lateLoss;
            // A setting changed since the check may have turned protection on, so honour it.
            const currentKeepWhen = resolveWorktreeCleanup(
              yield* settingsService.getSettings,
              thread.projectId,
            ).worktreeKeepWhen;
            if (currentKeepWhen !== keepWhen) return "settings changed since check";
            // Only "tracked-changes" opted into losing untracked files, so only it cleans them.
            if (keepWhen === "tracked-changes")
              yield* git.execute({
                operation: "DelegatedWorktreeReaper.clean",
                cwd: worktreePath,
                args: ["clean", "-ffdx"],
                timeoutMs: 300_000,
              });
            // Not forced: git refuses again if anything changed since the checks.
            yield* removeLinkedWorktree({
              operation: "DelegatedWorktreeReaper.remove",
              cwd: project.workspaceRoot,
              worktreePath,
              force: false,
              execute: git.execute,
              run: (args) =>
                git.execute({
                  operation: "DelegatedWorktreeReaper.remove",
                  cwd: project.workspaceRoot,
                  args: [...args],
                  timeoutMs: 300_000,
                }),
            });
            return null;
          }),
        );
        if (blocked !== null) return keep(blocked);
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        entry("removed", "finished, clean, and merged or pushed");
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            entry("failed", error instanceof Error ? error.message : String(error)),
          ),
        ),
      );
    }
    return report;
  });

  return DelegatedWorktreeReaper.of({
    // Untraced: the inner reap already opens the "DelegatedWorktreeReaper.reap" span.
    reap: Effect.fnUntraced(function* (options) {
      return yield* reap(options).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated worktree reap failed", { cause }).pipe(
            Effect.as([] as ReapReport),
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DelegatedWorktreeReaper, make);

const logReport = (report: ReapReport) =>
  Effect.forEach(
    report.filter((entry) => entry.outcome !== "would_remove"),
    (entry) => Effect.logInfo("delegated worktree reaper", entry),
    { discard: true },
  );

/** Reaps at startup, then hourly. Kept worktrees are logged so a stuck one can be found. */
export const layerSchedule = Layer.effectDiscard(
  Effect.gen(function* () {
    const reaper = yield* DelegatedWorktreeReaper;
    yield* forkParked(
      reaper
        .reap()
        .pipe(
          Effect.flatMap(logReport),
          Effect.repeat(Schedule.spaced(REAP_INTERVAL)),
          Effect.asVoid,
        ),
    );
  }),
).pipe(Layer.provideMerge(layer));
