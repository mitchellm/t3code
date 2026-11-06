// Fork: removes idle worktrees of every project repo T3 knows, whether or not a thread owns them,
// once the work in them is safe to lose. Covers T3's managed folder and `<repo>/.claude/worktrees`.
// Upstream's storageCleanup owns the user-configured rules; this reuses its eligibility helpers.
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "../storageCleanup.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { removeLinkedWorktree, removeTreeInChildProcess } from "../vcs/worktreeRemoval.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { makeIsManagedWorktreePath, managedWorktreesDirectories } from "../worktreesDirectory.ts";

/** A finished thread may still be inspected or resumed, and an agent may be mid-thought in a quiet checkout. */
const IDLE_MS = 24 * 60 * 60 * 1_000;
const REAP_INTERVAL = "1 hour";
const STAT_BATCH = 512;
// Seconds since the epoch of a reflog entry: `<old> <new> <name> <<email>> <seconds> <zone>\t<message>`.
const REFLOG_SECONDS = /> (\d+) [+-]\d{4}\t/;

const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

export type ReapOutcome = "removed" | "would_remove" | "kept" | "failed";
export interface ReapEntry {
  readonly path: string;
  /** The thread that works in the worktree; null when no thread does. */
  readonly threadId: string | null;
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
  const home = yield* HostProcess.HomeDirectory;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

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

  const modifiedAt = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) =>
        Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
      ),
      Effect.orElseSucceed(() => 0),
    );

  /** Whether a folder or any entry directly in it changed since `cutoff`; `.git` is bookkeeping, not use. */
  const touchedSince = Effect.fn("DelegatedWorktreeReaper.touchedSince")(function* (
    folder: string,
    cutoff: number,
  ) {
    const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => [] as string[]));
    const times = yield* Effect.forEach(
      [folder, ...names.filter((name) => name !== ".git").map((name) => path.join(folder, name))],
      modifiedAt,
      { concurrency: 16 },
    );
    return times.some((time) => time >= cutoff);
  });

  /**
   * A squash merge leaves commits that no remote contains, so only the pull request can say the
   * work landed. It must name this exact HEAD. No answer (no remote, no `gh`, offline) counts as not merged.
   */
  const mergedByPullRequest = Effect.fn("DelegatedWorktreeReaper.mergedByPullRequest")(
    function* (cwd: string, branch: string, repository: string, refresh: boolean) {
      const remote = yield* git.resolvePrimaryRemoteName(repository);
      const defaultBranch = yield* git.resolveDefaultBranchName(repository, remote);
      if (defaultBranch === null) return false;
      const [headSha] = yield* gitLines(cwd, ["rev-parse", "HEAD"]);
      const pullRequest = yield* gitManager.branchPullRequest({ cwd, branch }, { refresh });
      return storageCleanupPullRequestMerged(pullRequest, {
        branch,
        defaultBranch,
        headSha: headSha ?? "",
        // Reaching here means no other branch or remote ref holds HEAD.
        integrated: false,
      });
    },
    Effect.orElseSucceed(() => false),
  );

  /**
   * Null when nothing would be lost by deleting the checkout, otherwise why it must stay.
   * Ignored files (.env, build output) are removed with the worktree, as upstream's default
   * does; `worktreeKeepWhen` can protect them or relax the untracked-file check.
   */
  const lossReason = Effect.fn("DelegatedWorktreeReaper.lossReason")(function* (
    cwd: string,
    keepWhen: WorktreeKeepWhen,
    repository: string,
    refreshPullRequest: boolean,
  ) {
    // Workers rename t3/<name> to agent/<name> to open a PR, so judge whatever branch is out now.
    const current = yield* gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
      Effect.orElseSucceed(() => [] as string[]),
    );
    const branch = current[0];
    if (branch === undefined) return "HEAD is detached";
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
    if (yield* mergedByPullRequest(cwd, branch, repository, refreshPullRequest)) return null;
    return "has commits that are not merged or pushed";
  });

  /** Why the checkout counts as used within the idle window, or null. Cheap: two small git reads. */
  const headUsedReason = Effect.fn("DelegatedWorktreeReaper.headUsedReason")(function* (
    cwd: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const [commitSeconds] = yield* gitLines(cwd, ["log", "-1", "--format=%ct", "HEAD"]);
    const [gitDir] = yield* gitLines(cwd, ["rev-parse", "--absolute-git-dir"]);
    const reflog =
      gitDir === undefined
        ? ""
        : yield* fs
            .readFileString(path.join(gitDir, "logs", "HEAD"))
            .pipe(Effect.orElseSucceed(() => ""));
    const reflogSeconds = REFLOG_SECONDS.exec(reflog.trimEnd().split("\n").at(-1) ?? "")?.[1];
    const lastMoved = Math.max(Number(commitSeconds ?? 0), Number(reflogSeconds ?? 0)) * 1_000;
    return now - lastMoved < IDLE_MS ? "HEAD moved in the last 24 hours" : null;
  });

  /**
   * Why the checkout counts as used within the idle window by its files, or null. The index is no
   * signal (every `git status` rewrites it), so this looks at the top-level entries, which catch
   * build output git ignores, and then at tracked files until it finds a recent one.
   */
  const filesUsedReason = Effect.fn("DelegatedWorktreeReaper.filesUsedReason")(function* (
    cwd: string,
  ) {
    const cutoff = (yield* Clock.currentTimeMillis) - IDLE_MS;
    const reason = "a file changed in the last 24 hours";
    if (yield* touchedSince(cwd, cutoff)) return reason;
    const listing = yield* git.execute({
      operation: "DelegatedWorktreeReaper.trackedFiles",
      cwd,
      args: ["ls-files", "-z"],
      maxOutputBytes: 64 * 1024 * 1024,
      timeoutMs: 120_000,
    });
    const tracked = listing.stdout.split("\0").filter((name) => name !== "");
    for (let index = 0; index < tracked.length; index += STAT_BATCH) {
      const times = yield* Effect.forEach(
        tracked.slice(index, index + STAT_BATCH),
        (name) => modifiedAt(path.join(cwd, name)),
        { concurrency: 16 },
      );
      if (times.some((time) => time >= cutoff)) return reason;
    }
    return null;
  });

  /** Sessions can outlive their run, and only a live one protects its working directory. */
  const liveSessionIn = Effect.fn("DelegatedWorktreeReaper.liveSessionIn")(function* (
    folder: string,
  ) {
    const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_provider_sessions
        WHERE status != 'stopped'
      `.pipe(NodeSqliteClient.readOnly);
    for (const row of rows) {
      const session = yield* decodeSession(row.payload_json);
      const cwd = path.resolve(session.cwd);
      if (
        (pathKey(cwd) === pathKey(folder) || inside(folder, cwd)) &&
        (yield* providerSessions.isLive(session.id))
      )
        return true;
    }
    return false;
  });

  /**
   * Re-read the group after the first snapshot, under the workspace lease: a thread that resumed
   * since then, one that moved in, or a session still open on the path, must stop the removal.
   */
  const blockedSinceSnapshot = Effect.fn("DelegatedWorktreeReaper.blockedSinceSnapshot")(function* (
    worktreePath: string,
    group: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
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
          !storageCleanupThreadIdle(shell, now, settings) ||
          shell.branch !== before.branch ||
          pathKey(shell.worktreePath!) !== pathKey(worktreePath) ||
          storageCleanupActivityAt(shell) !== storageCleanupActivityAt(before) ||
          now - storageCleanupActivityAt(shell) < IDLE_MS
        );
      });
    if (changed) return "thread activity or shared worktree changed since check";
    return (yield* liveSessionIn(worktreePath)) ? "provider session is still open" : null;
  });

  const reap = Effect.fn("DelegatedWorktreeReaper.reap")(function* (options?: {
    readonly dryRun?: boolean;
  }) {
    const dryRun = options?.dryRun === true;
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const snapshot = yield* projections.getShellSnapshot();
    const projectShells = yield* projectStore.listShells();
    const threadsByPath = Map.groupBy(
      [...snapshot.threads, ...snapshot.archivedThreads].filter(
        (thread) => thread.worktreePath !== null && thread.deletedAt === null,
      ),
      (thread) => pathKey(thread.worktreePath!),
    );
    const managedRoots = managedWorktreesDirectories(
      settings,
      serverConfig.worktreesDir,
      path,
      home,
    );
    const report: ReapEntry[] = [];
    // The same repo can back several projects, and a worktree has one verdict per pass.
    const judged = new Set<string>();

    const isProjectCheckout = (realPath: string) =>
      projectShells.some(
        (candidate) =>
          pathKey(candidate.workspaceRoot) === pathKey(realPath) ||
          inside(realPath, candidate.workspaceRoot),
      );
    // A real folder directly in its parent, so a link or junction cannot point the delete elsewhere.
    const isPlainChild = Effect.fn("DelegatedWorktreeReaper.isPlainChild")(function* (
      folder: string,
      realPath: string,
    ) {
      const realParent = yield* fs.realPath(path.dirname(folder));
      return realPath === path.join(realParent, path.basename(folder));
    });

    const judgeWorktree = (
      project: (typeof projectShells)[number],
      worktreePath: string,
      location: "claude" | "managed",
    ) => {
      const group = threadsByPath.get(pathKey(worktreePath)) ?? [];
      const verdict = (outcome: ReapOutcome, reason: string): ReapEntry => ({
        path: worktreePath,
        threadId: group[0]?.id ?? null,
        outcome,
        reason,
      });
      const keep = (reason: string) => verdict("kept", reason);
      const keepWhen = resolveWorktreeCleanup(settings, project.id).worktreeKeepWhen;

      return Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return null;

        const realPath = yield* fs.realPath(worktreePath);
        const linked =
          (yield* fs.stat(path.join(worktreePath, ".git")).pipe(Effect.orElseSucceed(() => null)))
            ?.type === "File";
        if (
          isProjectCheckout(realPath) ||
          !linked ||
          !(yield* isPlainChild(worktreePath, realPath))
        )
          return keep("a project checkout, or not a plain linked worktree");

        if (group.length > 0) {
          // T3 recreates a thread's worktree from its branch, but only inside its own folder.
          if (location === "claude") return keep("a thread works in it and T3 cannot recreate it");
          if (group.some((thread) => thread.branch === null))
            return keep("its thread has no recorded branch");
          if (!group.every((thread) => storageCleanupThreadIdle(thread, now, settings)))
            return keep("a thread is still running or has pending work");
          if (now - Math.max(...group.map(storageCleanupActivityAt)) < IDLE_MS)
            return keep("its thread finished inside the 24 hour grace period");
        }

        const headUsed = yield* headUsedReason(worktreePath);
        if (headUsed !== null) return keep(headUsed);
        const loss = yield* lossReason(worktreePath, keepWhen, project.workspaceRoot, true);
        if (loss !== null) return keep(loss);
        const filesUsed = yield* filesUsedReason(worktreePath);
        if (filesUsed !== null) return keep(filesUsed);
        if (dryRun) return verdict("would_remove", "idle, clean, and merged or pushed");

        const blocked = yield* withWorkspaceLease(
          worktreePath,
          Effect.gen(function* () {
            const reason = yield* blockedSinceSnapshot(worktreePath, group);
            if (reason !== null) return reason;
            // The checks above ran before the lease, so run the git ones again under it.
            const lateLoss = yield* lossReason(
              worktreePath,
              keepWhen,
              project.workspaceRoot,
              false,
            );
            if (lateLoss !== null) return lateLoss;
            const lateUse =
              (yield* headUsedReason(worktreePath)) ?? (yield* filesUsedReason(worktreePath));
            if (lateUse !== null) return lateUse;
            // A setting changed since the check may have turned protection on, so honour it.
            const currentKeepWhen = resolveWorktreeCleanup(
              yield* settingsService.getSettings,
              project.id,
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
        return verdict("removed", "idle, clean, and merged or pushed");
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(verdict("failed", error instanceof Error ? error.message : String(error))),
        ),
      );
    };

    /** A folder a failed delete left behind: no `.git`, and git no longer lists it as a worktree. */
    const judgeDeadFolder = (folder: string) => {
      const verdict = (outcome: ReapOutcome, reason: string): ReapEntry => ({
        path: folder,
        threadId: null,
        outcome,
        reason,
      });
      const keep = (reason: string) => verdict("kept", reason);
      const usedReason = Effect.gen(function* () {
        const cutoff = (yield* Clock.currentTimeMillis) - IDLE_MS;
        if (yield* touchedSince(folder, cutoff)) return "touched in the last 24 hours";
        return (yield* liveSessionIn(folder)) ? "provider session is still open" : null;
      });

      return Effect.gen(function* () {
        if (threadsByPath.has(pathKey(folder))) return keep("a thread still points at it");
        const realPath = yield* fs.realPath(folder);
        if (isProjectCheckout(realPath) || !(yield* isPlainChild(folder, realPath)))
          return keep("a project checkout, or not a plain folder");
        const used = yield* usedReason;
        if (used !== null) return keep(used);
        if (dryRun) return verdict("would_remove", "no .git, and git does not list it");

        const outcome = yield* withWorkspaceLease(
          folder,
          Effect.gen(function* () {
            const lateUse = yield* usedReason;
            if (lateUse !== null) return keep(lateUse);
            if (yield* fs.exists(path.join(folder, ".git")))
              return keep("gained a .git since check");
            const exitCode = yield* removeTreeInChildProcess(folder);
            return exitCode === 0
              ? verdict("removed", "no .git, and git does not list it")
              : verdict("failed", `deleting the folder exited with ${exitCode}`);
          }),
        );
        return outcome;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(verdict("failed", error instanceof Error ? error.message : String(error))),
        ),
      );
    };

    const scannedRoots = new Set<string>();
    for (const project of projectShells) {
      // A project that is not a git repository has no worktrees to judge.
      const listed = yield* git
        .listWorktreePaths(project.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      const [main, ...linkedWorktrees] = listed;
      if (main === undefined) continue;
      const listedKeys = new Set(listed.map(pathKey));
      const claudeRoot = path.join(main, ".claude", "worktrees");
      let removedAny = false;
      const record = (entry: ReapEntry | null) => {
        if (entry === null) return;
        report.push(entry);
        removedAny ||= entry.outcome === "removed";
      };

      for (const worktreePath of linkedWorktrees) {
        const location =
          pathKey(path.dirname(worktreePath)) === pathKey(claudeRoot)
            ? ("claude" as const)
            : (yield* isManagedWorktreePath(worktreePath))
              ? ("managed" as const)
              : null;
        if (location === null || judged.has(pathKey(worktreePath))) continue;
        judged.add(pathKey(worktreePath));
        record(yield* judgeWorktree(project, worktreePath, location));
      }

      // T3 names the folder after the project root it created the worktree from. An empty name
      // would make the managed root itself the scanned folder.
      const repositoryNames = new Set([path.basename(main), path.basename(project.workspaceRoot)]);
      repositoryNames.delete("");
      const roots = [
        claudeRoot,
        ...managedRoots.flatMap((root) =>
          [...repositoryNames].map((name) => path.join(root, name)),
        ),
      ];
      for (const root of roots) {
        if (scannedRoots.has(pathKey(root))) continue;
        scannedRoots.add(pathKey(root));
        const entries = yield* fs.readDirectoryEntries(root).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          const folder = path.join(root, entry.name);
          if (
            entry.type !== "Directory" ||
            listedKeys.has(pathKey(folder)) ||
            judged.has(pathKey(folder)) ||
            (yield* fs.exists(path.join(folder, ".git")).pipe(Effect.orElseSucceed(() => true)))
          )
            continue;
          judged.add(pathKey(folder));
          record(yield* judgeDeadFolder(folder));
        }
      }

      // Removing a half-deleted worktree's folder leaves git's record of it behind.
      if (removedAny && !dryRun)
        yield* git
          .pruneWorktrees({ cwd: main })
          .pipe(
            Effect.catch(() =>
              Effect.logWarning("delegated worktree reaper could not prune", { repository: main }),
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
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
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
