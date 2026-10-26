// Fork: removes the worktrees T3 made for delegated child threads once the work is safe to lose.
// Upstream's storageCleanup owns the user-configured rules (age, merge, delete) for every thread;
// this adds the one rule delegation needs, "a finished worker's checkout is disposable", and
// reuses its eligibility helpers and the same linked-worktree removal.
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "../storageCleanup.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { removeLinkedWorktree } from "../vcs/worktreeRemoval.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";

/** A finished child may still be inspected or resumed shortly after it completes. */
export const DELEGATED_WORKTREE_GRACE_MS = 24 * 60 * 60 * 1_000;
const REAP_INTERVAL = "1 hour";
const FINISHED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

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

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isWindows = yield* HostProcess.isWindows;
  const home = yield* HostProcess.HomeDirectory;

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

  /** Null when nothing would be lost by deleting the checkout, otherwise why it must stay. */
  const lossReason = Effect.fn("DelegatedWorktreeReaper.lossReason")(function* (
    cwd: string,
    branch: string,
  ) {
    const current = yield* gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
      Effect.orElseSucceed(() => [] as string[]),
    );
    if (current[0] !== branch) return "its branch changed since the thread started";
    const changes = yield* gitLines(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (changes.length > 0) return `has uncommitted changes (${changes.length} files)`;
    // Contained in another local branch means merged; contained in a remote ref means pushed.
    const [local, remote] = yield* Effect.all([
      gitLines(cwd, ["branch", "--contains", "HEAD", "--format=%(refname:short)"]),
      gitLines(cwd, ["branch", "--remotes", "--contains", "HEAD", "--format=%(refname:short)"]),
    ]);
    if (local.some((name) => name !== branch) || remote.length > 0) return null;
    return "has commits that are not merged or pushed";
  });

  const reap = Effect.fn("DelegatedWorktreeReaper.reap")(function* (options?: {
    readonly dryRun?: boolean;
  }) {
    const dryRun = options?.dryRun === true;
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const roots: string[] = [];
    for (const directory of managedWorktreesDirectories(
      settings,
      config.worktreesDir,
      path,
      home,
    )) {
      const root = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => null));
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
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

      yield* Effect.gen(function* () {
        if (delegated.length !== group.length)
          return keep("shared with a thread that was not delegated");
        if (
          !group.every(
            (member) =>
              FINISHED_STATUSES.has(member.status) && storageCleanupThreadIdle(member, now),
          )
        )
          return keep("a child thread is still running or has pending work");
        const idleFor = now - Math.max(...group.map(storageCleanupActivityAt));
        if (idleFor < DELEGATED_WORKTREE_GRACE_MS)
          return keep("finished inside the 24 hour grace period");
        if (!(yield* fs.exists(worktreePath))) return;

        // Ownership: a real linked worktree inside T3's own folder, never a project checkout
        // or one another tool made (Claude Code's .claude/worktrees is outside it).
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
          !roots.some((root) => inside(root, realPath))
        )
          return keep("not created by T3 for a delegated task");
        if (thread.branch === null) return keep("its thread has no recorded branch");

        const loss = yield* lossReason(worktreePath, thread.branch);
        if (loss !== null) return keep(loss);
        if (dryRun) return entry("would_remove", "finished, clean, and merged or pushed");

        yield* withWorkspaceLease(
          worktreePath,
          // Not forced: git refuses again if anything changed since the check above.
          removeLinkedWorktree({
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
          }),
        );
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
    reap: (options) =>
      reap(options).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated worktree reap failed", { cause }).pipe(
            Effect.as([] as ReapReport),
          ),
        ),
      ),
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
