import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as GitManager from "../git/GitManager.ts";
import * as Settings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as DelegatedWorktreeReaper from "./DelegatedWorktreeReaper.ts";

const NOW_MS = Date.parse("2026-10-26T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const at = (offsetMs: number) => DateTime.makeUnsafe(NOW_MS + offsetMs);
const projectId = ProjectId.make("project-1");
const parentId = ThreadId.make("thread-parent");

const shell = (overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell => ({
  id: ThreadId.make("thread-child"),
  projectId,
  title: "Delegated worker",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
  forkedFrom: null,
  createdBy: "agent",
  creationSource: "mcp",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: null,
  linkedPullRequest: null,
  status: "completed",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: null,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: at(-48 * HOUR_MS),
  latestUserMessageAt: null,
  createdAt: at(-72 * HOUR_MS),
  updatedAt: at(-48 * HOUR_MS),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  ...overrides,
});

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "delegated-reaper-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A project repo plus one linked worktree per name, in T3's managed worktree folder. */
const fixture = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "reaper-repo-" }));
    const run = (cwd: string, args: string[]) =>
      git.execute({ operation: "reaper-test", cwd, args });
    yield* run(repo, ["init", "-b", "main"]);
    yield* run(repo, ["config", "user.email", "reaper@example.test"]);
    yield* run(repo, ["config", "user.name", "Reaper test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* run(repo, ["add", "."]);
    yield* run(repo, ["commit", "-m", "initial"]);
    // T3 keeps worktrees at <managed root>/<repo>/<name>.
    yield* fs.makeDirectory(`${config.worktreesDir}/repo`, { recursive: true });
    const worktrees: Record<string, string> = {};
    for (const name of names) {
      worktrees[name] = `${config.worktreesDir}/repo/${name}`;
      yield* run(repo, ["worktree", "add", "-b", name, worktrees[name]!]);
      yield* run(worktrees[name]!, ["config", "user.email", "reaper@example.test"]);
      yield* run(worktrees[name]!, ["config", "user.name", "Reaper test"]);
    }
    return { fs, repo, run, worktrees, config };
  });

interface ReaperHooks {
  /** Runs right after the reaper reads its snapshot; returns the threads as they are by then. */
  afterSnapshot?: () => ReadonlyArray<OrchestrationV2ThreadShell>;
  /** A provider session whose working directory is this path, reported live. */
  liveSessionCwd?: string;
  readonly invalidated: string[];
}

const reaperFor = (
  repo: string,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  hooks: ReaperHooks = { invalidated: [] },
) =>
  Effect.gen(function* () {
    let current = threads;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const config = yield* ServerConfig.ServerConfig;
    const context = yield* Layer.build(DelegatedWorktreeReaper.layer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, git),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([{ id: projectId, workspaceRoot: repo }]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: () =>
          Effect.sync(() => {
            const snapshot = { threads: current, archivedThreads: [] };
            current = hooks.afterSnapshot?.() ?? current;
            return snapshot;
          }),
        getThreadWorktreePaths: () =>
          Effect.sync(() =>
            current.flatMap((thread) =>
              thread.worktreePath === null
                ? []
                : [{ threadId: thread.id, worktreePath: thread.worktreePath }],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => current.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () => Effect.succeed(true),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: (cwd: string) => Effect.sync(() => void hooks.invalidated.push(cwd)),
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(SqlClient.SqlClient, (() =>
        Effect.succeed(
          hooks.liveSessionCwd === undefined
            ? []
            : [
                {
                  payload_json: JSON.stringify({
                    id: "session-1",
                    driver: "codex",
                    providerInstanceId: "codex",
                    status: "ready",
                    cwd: hooks.liveSessionCwd,
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: "2026-06-01T12:00:00.000Z",
                    updatedAt: "2026-06-01T12:00:00.000Z",
                    lastError: null,
                  }),
                },
              ],
        )) as unknown as SqlClient.SqlClient),
    );
    yield* TestClock.setTime(NOW_MS);
    return Context.get(context, DelegatedWorktreeReaper.DelegatedWorktreeReaper);
  });

const parent = shell({
  id: parentId,
  createdBy: "user",
  creationSource: "web",
  lineage: { rootThreadId: parentId, parentThreadId: null, relationshipToParent: null },
});

const child = (name: string, worktrees: Record<string, string>, overrides = {}) =>
  shell({
    id: ThreadId.make(`thread-${name}`),
    branch: name,
    worktreePath: worktrees[name]!,
    ...overrides,
  });

const normalize = (path: string) => path.replaceAll("\\", "/").toLowerCase();

const outcomeOf = (entries: DelegatedWorktreeReaper.ReapReport, path: string) =>
  // The reaper reports resolved paths, which use backslashes on Windows.
  entries.find((entry) => normalize(entry.path) === normalize(path));

describe("DelegatedWorktreeReaper", () => {
  it.effect("removes a finished delegated worktree whose branch is merged or untouched", () =>
    Effect.gen(function* () {
      const { fs, repo, run, worktrees } = yield* fixture(["untouched", "merged"]);
      yield* fs.writeFileString(`${worktrees.merged}/done.txt`, "done\n");
      yield* run(worktrees.merged!, ["add", "done.txt"]);
      yield* run(worktrees.merged!, ["commit", "-m", "work"]);
      yield* run(repo, ["merge", "--no-ff", "-m", "merge", "merged"]);
      const reaper = yield* reaperFor(repo, [
        parent,
        child("untouched", worktrees),
        child("merged", worktrees),
      ]);

      const report = yield* reaper.reap();

      expect(outcomeOf(report, worktrees.untouched!)?.outcome).toBe("removed");
      expect(outcomeOf(report, worktrees.merged!)?.outcome).toBe("removed");
      expect(yield* fs.exists(worktrees.untouched!)).toBe(false);
      expect(yield* fs.exists(worktrees.merged!)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("previews without removing anything", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["untouched"]);
      const reaper = yield* reaperFor(repo, [parent, child("untouched", worktrees)]);

      const report = yield* reaper.reap({ dryRun: true });

      expect(outcomeOf(report, worktrees.untouched!)?.outcome).toBe("would_remove");
      expect(yield* fs.exists(worktrees.untouched!)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps and lists a worktree with uncommitted changes", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["dirty", "untracked"]);
      yield* fs.writeFileString(`${worktrees.dirty}/tracked.txt`, "edited\n");
      yield* fs.writeFileString(`${worktrees.untracked}/new.txt`, "new\n");
      const reaper = yield* reaperFor(repo, [
        parent,
        child("dirty", worktrees),
        child("untracked", worktrees),
      ]);

      const report = yield* reaper.reap();

      for (const name of ["dirty", "untracked"]) {
        const entry = outcomeOf(report, worktrees[name]!);
        expect(entry?.outcome).toBe("kept");
        expect(entry?.reason).toContain("uncommitted");
        expect(yield* fs.exists(worktrees[name]!)).toBe(true);
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps a worktree with commits that are neither merged nor pushed", () =>
    Effect.gen(function* () {
      const { fs, repo, run, worktrees } = yield* fixture(["unmerged"]);
      yield* fs.writeFileString(`${worktrees.unmerged}/work.txt`, "work\n");
      yield* run(worktrees.unmerged!, ["add", "work.txt"]);
      yield* run(worktrees.unmerged!, ["commit", "-m", "unmerged work"]);
      const reaper = yield* reaperFor(repo, [parent, child("unmerged", worktrees)]);

      const report = yield* reaper.reap();

      expect(outcomeOf(report, worktrees.unmerged!)?.outcome).toBe("kept");
      expect(outcomeOf(report, worktrees.unmerged!)?.reason).toContain("not merged or pushed");
      expect(yield* fs.exists(worktrees.unmerged!)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("removes clean work that was pushed to a remote, since nothing is lost", () =>
    Effect.gen(function* () {
      const { fs, repo, run, worktrees } = yield* fixture(["pushed"]);
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "reaper-remote-" });
      yield* run(remote, ["init", "--bare", "-b", "main"]);
      yield* run(repo, ["remote", "add", "origin", remote]);
      yield* fs.writeFileString(`${worktrees.pushed}/work.txt`, "work\n");
      yield* run(worktrees.pushed!, ["add", "work.txt"]);
      yield* run(worktrees.pushed!, ["commit", "-m", "pushed work"]);
      yield* run(worktrees.pushed!, ["push", "origin", "pushed"]);
      const reaper = yield* reaperFor(repo, [parent, child("pushed", worktrees)]);

      expect(outcomeOf(yield* reaper.reap(), worktrees.pushed!)?.outcome).toBe("removed");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps a worktree whose child is unfinished or finished inside the grace period", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["running", "young", "waiting"]);
      const reaper = yield* reaperFor(repo, [
        parent,
        child("running", worktrees, { status: "running", activeRunId: "run-1" }),
        child("young", worktrees, {
          latestRunCompletedAt: at(-HOUR_MS),
          createdAt: at(-2 * HOUR_MS),
        }),
        child("waiting", worktrees, { status: "waiting" }),
      ]);

      const report = yield* reaper.reap();

      expect(outcomeOf(report, worktrees.running!)?.outcome).toBe("kept");
      expect(outcomeOf(report, worktrees.waiting!)?.outcome).toBe("kept");
      expect(outcomeOf(report, worktrees.young!)?.reason).toContain("grace");
      for (const name of ["running", "young", "waiting"])
        expect(yield* fs.exists(worktrees[name]!)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps a worktree whose child resumed after the snapshot was read", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["resumed"]);
      const finished = child("resumed", worktrees);
      const hooks: ReaperHooks = {
        invalidated: [],
        // The child starts a new run between the reaper's snapshot and its removal.
        afterSnapshot: () => [
          parent,
          { ...finished, status: "running", activeRunId: "run-2" as never },
        ],
      };
      const reaper = yield* reaperFor(repo, [parent, finished], hooks);

      const report = yield* reaper.reap();

      expect(outcomeOf(report, worktrees.resumed!)?.outcome).toBe("kept");
      expect(outcomeOf(report, worktrees.resumed!)?.reason).toContain("changed since check");
      expect(yield* fs.exists(worktrees.resumed!)).toBe(true);
      expect(hooks.invalidated).toEqual([]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps a worktree while a live provider session is open in it", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["session"]);
      const reaper = yield* reaperFor(repo, [parent, child("session", worktrees)], {
        invalidated: [],
        liveSessionCwd: worktrees.session!,
      });

      const report = yield* reaper.reap();

      expect(outcomeOf(report, worktrees.session!)?.reason).toContain("session is still open");
      expect(yield* fs.exists(worktrees.session!)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("refreshes git status after removing, and treats interrupted as finished", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["stopped"]);
      const hooks: ReaperHooks = { invalidated: [] };
      const reaper = yield* reaperFor(
        repo,
        [parent, child("stopped", worktrees, { status: "interrupted" })],
        hooks,
      );

      expect(outcomeOf(yield* reaper.reap(), worktrees.stopped!)?.outcome).toBe("removed");
      expect(yield* fs.exists(worktrees.stopped!)).toBe(false);
      expect(hooks.invalidated).toEqual([repo]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("only reaps worktrees at exactly <root>/<repo>/<name>", () =>
    Effect.gen(function* () {
      const { fs, repo, run, config } = yield* fixture([]);
      const deep = `${config.worktreesDir}/repo/nested/deep`;
      yield* run(repo, ["worktree", "add", "-b", "deep", deep]);
      const reaper = yield* reaperFor(repo, [
        parent,
        shell({ id: ThreadId.make("thread-deep"), branch: "deep", worktreePath: deep }),
      ]);

      const entry = outcomeOf(yield* reaper.reap(), deep);

      expect(entry?.outcome).toBe("kept");
      expect(entry?.reason).toContain("not created by T3");
      expect(yield* fs.exists(deep)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("never touches worktrees T3 did not create for a delegated child", () =>
    Effect.gen(function* () {
      const { fs, repo, run, worktrees } = yield* fixture(["userthread", "shared"]);
      // Claude Code's own worktree: a real linked worktree, outside T3's folder, no thread of T3's.
      const foreign = `${repo}/.claude/worktrees/claude-made`;
      yield* run(repo, ["worktree", "add", "-b", "claude-made", foreign]);
      // A delegated thread that points at a path outside T3's folder.
      const outside = yield* reaperFor(repo, [
        parent,
        child("userthread", worktrees, { createdBy: "user", creationSource: "web" }),
        child("shared", worktrees),
        shell({
          id: ThreadId.make("thread-claude"),
          branch: "claude-made",
          worktreePath: foreign,
        }),
        shell({
          id: ThreadId.make("thread-shares-shared"),
          branch: "shared",
          worktreePath: worktrees.shared!,
          createdBy: "user",
          creationSource: "web",
          lineage: {
            rootThreadId: ThreadId.make("thread-shares-shared"),
            parentThreadId: null,
            relationshipToParent: null,
          },
        }),
      ]);

      const report = yield* outside.reap();

      expect(outcomeOf(report, foreign)?.outcome).toBe("kept");
      expect(outcomeOf(report, foreign)?.reason).toContain("not created by T3");
      expect(outcomeOf(report, worktrees.shared!)?.outcome).toBe("kept");
      // A worktree a user's own thread works in is not a delegated child's to reap.
      expect(outcomeOf(report, worktrees.userthread!)).toBeUndefined();
      for (const path of [foreign, worktrees.shared!, worktrees.userthread!])
        expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
