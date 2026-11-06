import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type WorktreeKeepWhen,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
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
const dateAt = (offsetMs: number) => DateTime.toDateUtc(at(offsetMs));
// Git stamps commits and reflog entries from these, so a fixture repo looks three days old.
const gitDatesAt = (offsetMs: number) => ({
  GIT_AUTHOR_DATE: DateTime.formatIso(at(offsetMs)),
  GIT_COMMITTER_DATE: DateTime.formatIso(at(offsetMs)),
});

class PullRequestLookupError extends Data.TaggedError("PullRequestLookupError")<{}> {}
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
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** A project repo plus one linked worktree per name, in T3's managed worktree folder. */
const fixture = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "reaper-repo-" }));
    const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = gitDatesAt(-72 * HOUR_MS)) =>
      git.execute({ operation: "reaper-test", cwd, args, env });
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

type Run = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => ReturnType<GitVcsDriver.GitVcsDriver["Service"]["execute"]>;

/** Claude Code's own layout: a linked worktree at <repo>/.claude/worktrees/<name>. */
const addClaudeWorktree = (repo: string, run: Run, name: string) =>
  Effect.gen(function* () {
    const dir = `${repo}/.claude/worktrees/${name}`;
    yield* run(repo, ["worktree", "add", "-b", name, dir]);
    yield* run(dir, ["config", "user.email", "reaper@example.test"]);
    yield* run(dir, ["config", "user.name", "Reaper test"]);
    return dir;
  });

/** A bare origin that knows `main`, so "pushed" and the default branch both exist. */
const addRemote = (repo: string, run: Run) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "reaper-remote-" });
    yield* run(remote, ["init", "--bare", "-b", "main"]);
    yield* run(repo, ["remote", "add", "origin", remote]);
    yield* run(repo, ["push", "origin", "main"]);
    yield* run(repo, ["remote", "set-head", "origin", "main"]);
  });

const commitFile = (dir: string, run: Run, name: string, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${dir}/${name}`, `${name}\n`);
    yield* run(dir, ["add", name]);
    yield* run(dir, ["commit", "-m", name], env);
  });

const headOf = (dir: string, run: Run) =>
  run(dir, ["rev-parse", "HEAD"]).pipe(Effect.map((result) => result.stdout.trim()));

/** Files carry the real clock, so push everything under `root` back to the fixture's age. */
const ageTree = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(root))) return;
    const old = dateAt(-72 * HOUR_MS);
    const entries = yield* fs.readDirectory(root, { recursive: true });
    for (const target of [root, ...entries.map((entry) => `${root}/${entry}`)])
      yield* fs.utimes(target, old, old);
  });

const touch = (target: string, offsetMs: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.utimes(target, dateAt(offsetMs), dateAt(offsetMs));
  });

type PullRequestStub = Pick<
  GitManager.GitBranchPullRequest,
  "state" | "headRef" | "baseRef" | "headSha"
>;

interface ReaperHooks {
  /** What the pull request lookup answers for a branch; a failure stands for `gh` being unavailable. */
  pullRequest?: (branch: string) => Effect.Effect<PullRequestStub | null, PullRequestLookupError>;
  /** More project roots than the repo itself, for checkouts that are projects of their own. */
  extraProjectRoots?: ReadonlyArray<string>;
  /** Runs right after the reaper reads its snapshot; returns the threads as they are by then. */
  afterSnapshot?: () => ReadonlyArray<OrchestrationV2ThreadShell>;
  /** A provider session whose working directory is this path, reported live. */
  liveSessionCwd?: string;
  /** The worktreeKeepWhen setting; mutate it in afterSnapshot to change it mid-reap. */
  keepWhen?: WorktreeKeepWhen;
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
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          storageCleanup: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeKeepWhen:
              hooks.keepWhen ?? DEFAULT_SERVER_SETTINGS.storageCleanup.worktreeKeepWhen,
          },
        })),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () =>
          Effect.succeed([
            { id: projectId, workspaceRoot: repo },
            ...(hooks.extraProjectRoots ?? []).map((workspaceRoot, index) => ({
              id: ProjectId.make(`project-extra-${index}`),
              workspaceRoot,
            })),
          ]),
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
        branchPullRequest: (input: { readonly branch: string }) =>
          hooks.pullRequest?.(input.branch) ?? Effect.succeed(null),
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
    // Tests that need a recent file or reflog entry set it after this call.
    yield* ageTree(config.worktreesDir);
    yield* ageTree(`${repo}/.claude`);
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

  it.effect("tracked-changes cleans an untracked file and removes the worktree", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["scratch"]);
      yield* fs.writeFileString(`${worktrees.scratch}/scratch.txt`, "scratch\n");
      const reaper = yield* reaperFor(repo, [parent, child("scratch", worktrees)], {
        invalidated: [],
        keepWhen: "tracked-changes",
      });

      expect(outcomeOf(yield* reaper.reap(), worktrees.scratch!)?.outcome).toBe("removed");
      expect(yield* fs.exists(worktrees.scratch!)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("tracked-changes still keeps a worktree with a tracked edit", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["edited"]);
      yield* fs.writeFileString(`${worktrees.edited}/tracked.txt`, "edited\n");
      const reaper = yield* reaperFor(repo, [parent, child("edited", worktrees)], {
        invalidated: [],
        keepWhen: "tracked-changes",
      });

      expect(outcomeOf(yield* reaper.reap(), worktrees.edited!)?.outcome).toBe("kept");
      expect(yield* fs.exists(worktrees.edited!)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("any-local-files keeps a worktree holding an ignored file", () =>
    Effect.gen(function* () {
      const { fs, repo, run, worktrees } = yield* fixture(["env"]);
      // An ignored file shows in no status, so only this setting protects it.
      yield* fs.writeFileString(`${repo}/.gitignore`, ".env\n");
      yield* run(repo, ["add", ".gitignore"]);
      yield* run(repo, ["commit", "-m", "ignore env"]);
      yield* run(worktrees.env!, ["merge", "main"]);
      yield* fs.writeFileString(`${worktrees.env}/.env`, "SECRET=1\n");
      const reaper = yield* reaperFor(repo, [parent, child("env", worktrees)], {
        invalidated: [],
        keepWhen: "any-local-files",
      });

      const entry = outcomeOf(yield* reaper.reap(), worktrees.env!);

      expect(entry?.outcome).toBe("kept");
      expect(entry?.reason).toContain("ignored files");
      expect(yield* fs.exists(`${worktrees.env}/.env`)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("any-local-files also keeps a worktree with an untracked file", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["untracked"]);
      yield* fs.writeFileString(`${worktrees.untracked}/new.txt`, "new\n");
      const reaper = yield* reaperFor(repo, [parent, child("untracked", worktrees)], {
        invalidated: [],
        keepWhen: "any-local-files",
      });

      expect(outcomeOf(yield* reaper.reap(), worktrees.untracked!)?.outcome).toBe("kept");
      expect(yield* fs.exists(`${worktrees.untracked}/new.txt`)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps a worktree when the keep setting changed after the check", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["late"]);
      yield* fs.writeFileString(`${worktrees.late}/scratch.txt`, "scratch\n");
      const hooks: ReaperHooks = {
        invalidated: [],
        keepWhen: "tracked-changes",
        // The user turns protection on after the reaper read its settings.
        afterSnapshot: () => {
          hooks.keepWhen = "any-local-files";
          return [parent, child("late", worktrees)];
        },
      };
      const reaper = yield* reaperFor(repo, [parent, child("late", worktrees)], hooks);

      const entry = outcomeOf(yield* reaper.reap(), worktrees.late!);

      expect(entry?.reason).toContain("settings changed since check");
      expect(yield* fs.exists(`${worktrees.late}/scratch.txt`)).toBe(true);
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

  it.effect("removes a worktree whose branch was renamed and pushed, keeps a detached one", () =>
    Effect.gen(function* () {
      const { fs, repo, run, worktrees } = yield* fixture(["renamed", "renamedLocal", "detached"]);
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "reaper-remote-" });
      yield* run(remote, ["init", "--bare", "-b", "main"]);
      yield* run(repo, ["remote", "add", "origin", remote]);
      // The PR flow: commit on t3/<name>, rename to agent/<name>, push.
      yield* fs.writeFileString(`${worktrees.renamed}/work.txt`, "work\n");
      yield* run(worktrees.renamed!, ["add", "work.txt"]);
      yield* run(worktrees.renamed!, ["commit", "-m", "pr work"]);
      yield* run(worktrees.renamed!, ["branch", "-m", "agent/renamed"]);
      yield* run(worktrees.renamed!, ["push", "origin", "agent/renamed"]);
      // Renamed with an unpushed commit: losing it would lose work.
      yield* fs.writeFileString(`${worktrees.renamedLocal}/work.txt`, "work\n");
      yield* run(worktrees.renamedLocal!, ["add", "work.txt"]);
      yield* run(worktrees.renamedLocal!, ["commit", "-m", "local work"]);
      yield* run(worktrees.renamedLocal!, ["branch", "-m", "agent/renamed-local"]);
      yield* run(worktrees.detached!, ["checkout", "--detach"]);
      const reaper = yield* reaperFor(repo, [
        parent,
        child("renamed", worktrees),
        child("renamedLocal", worktrees),
        child("detached", worktrees),
      ]);

      const report = yield* reaper.reap();

      expect(outcomeOf(report, worktrees.renamed!)?.outcome).toBe("removed");
      expect(outcomeOf(report, worktrees.renamedLocal!)?.reason).toContain("not merged or pushed");
      expect(outcomeOf(report, worktrees.detached!)?.reason).toContain("detached");
      expect(yield* fs.exists(worktrees.renamed!)).toBe(false);
      expect(yield* fs.exists(worktrees.renamedLocal!)).toBe(true);
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

      // Neither T3's layout nor Claude Code's, so it is not a candidate at all.
      expect(outcomeOf(yield* reaper.reap(), deep)).toBeUndefined();
      expect(yield* fs.exists(deep)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps a worktree a finished child shares with a thread that is still working", () =>
    Effect.gen(function* () {
      const { fs, repo, worktrees } = yield* fixture(["shared"]);
      const reaper = yield* reaperFor(repo, [
        parent,
        child("shared", worktrees),
        shell({
          id: ThreadId.make("thread-shares-shared"),
          branch: "shared",
          worktreePath: worktrees.shared!,
          createdBy: "user",
          creationSource: "web",
          status: "running",
          activeRunId: "run-1" as never,
          lineage: {
            rootThreadId: ThreadId.make("thread-shares-shared"),
            parentThreadId: null,
            relationshipToParent: null,
          },
        }),
      ]);

      const entry = outcomeOf(yield* reaper.reap(), worktrees.shared!);

      expect(entry?.outcome).toBe("kept");
      expect(entry?.reason).toContain("still running");
      expect(yield* fs.exists(worktrees.shared!)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("DelegatedWorktreeReaper over every worktree of a project repo", () => {
  it.effect("removes an unowned clean pushed idle .claude worktree", () =>
    Effect.gen(function* () {
      const { fs, repo, run } = yield* fixture([]);
      yield* addRemote(repo, run);
      const dir = yield* addClaudeWorktree(repo, run, "pushed-work");
      yield* commitFile(dir, run, "work.txt");
      yield* run(dir, ["push", "origin", "pushed-work"]);
      const reaper = yield* reaperFor(repo, []);

      const entry = outcomeOf(yield* reaper.reap(), dir);

      expect(entry?.outcome).toBe("removed");
      expect(entry?.threadId).toBeNull();
      expect(yield* fs.exists(dir)).toBe(false);
      expect((yield* run(repo, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
        "pushed-work",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps an unowned worktree that is dirty, unpushed, recently used, or open", () =>
    Effect.gen(function* () {
      const { fs, repo, run } = yield* fixture([]);
      const dirty = yield* addClaudeWorktree(repo, run, "dirty");
      yield* fs.writeFileString(`${dirty}/tracked.txt`, "edited\n");
      const unpushed = yield* addClaudeWorktree(repo, run, "unpushed");
      yield* commitFile(unpushed, run, "unpushed.txt");
      const recentFile = yield* addClaudeWorktree(repo, run, "recent-file");
      // Moving HEAD touches no file and makes no commit; only the reflog records it.
      const recentReflog = yield* addClaudeWorktree(repo, run, "recent-reflog");
      yield* run(recentReflog, ["checkout", "-b", "moved"], gitDatesAt(-HOUR_MS));
      // Made before main moves on, so its own HEAD is still three days old.
      const open = yield* addClaudeWorktree(repo, run, "open");
      const recentCommit = yield* addClaudeWorktree(repo, run, "recent-commit");
      yield* commitFile(recentCommit, run, "recent.txt", gitDatesAt(-HOUR_MS));
      yield* run(repo, ["merge", "--ff-only", "recent-commit"]);
      const reaper = yield* reaperFor(repo, [], { invalidated: [], liveSessionCwd: open });
      yield* touch(`${recentFile}/tracked.txt`, -HOUR_MS);

      const report = yield* reaper.reap();

      const reasons = {
        [dirty]: "uncommitted",
        [unpushed]: "not merged or pushed",
        [recentFile]: "last 24 hours",
        [recentReflog]: "last 24 hours",
        [recentCommit]: "last 24 hours",
        [open]: "session is still open",
      };
      for (const [dir, reason] of Object.entries(reasons)) {
        const entry = outcomeOf(report, dir);
        expect({ dir, outcome: entry?.outcome }).toEqual({ dir, outcome: "kept" });
        expect(entry?.reason).toContain(reason);
        expect(yield* fs.exists(dir)).toBe(true);
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("treats a squash-merged branch as merged only when its pull request names HEAD", () =>
    Effect.gen(function* () {
      const { repo, run } = yield* fixture([]);
      yield* addRemote(repo, run);
      const dirs: Record<string, string> = {};
      const heads: Record<string, string> = {};
      for (const name of ["squashed", "stale", "open", "offline"]) {
        dirs[name] = yield* addClaudeWorktree(repo, run, name);
        // Squash-merged: the remote has a different commit, so no remote ref contains this one.
        // Each file name is unique, or the branches would share one commit and look merged.
        yield* commitFile(dirs[name]!, run, `${name}.txt`);
        heads[name] = yield* headOf(dirs[name]!, run);
      }
      const pullRequest = (branch: string) =>
        branch === "squashed"
          ? Effect.succeed({
              state: "merged",
              headRef: branch,
              baseRef: "main",
              headSha: heads[branch]!,
            } as const)
          : branch === "stale"
            ? Effect.succeed({
                state: "merged",
                headRef: branch,
                baseRef: "main",
                headSha: "0".repeat(40),
              } as const)
            : branch === "open"
              ? Effect.succeed({
                  state: "open",
                  headRef: branch,
                  baseRef: "main",
                  headSha: heads[branch]!,
                } as const)
              : Effect.fail(new PullRequestLookupError());
      const reaper = yield* reaperFor(repo, [], { invalidated: [], pullRequest });

      const report = yield* reaper.reap();

      expect(outcomeOf(report, dirs.squashed!)?.outcome).toBe("removed");
      for (const name of ["stale", "open", "offline"]) {
        const entry = outcomeOf(report, dirs[name]!);
        expect(entry?.outcome).toBe("kept");
        expect(entry?.reason).toContain("not merged or pushed");
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("removes dead folders with no .git, prunes git, and spares everything else", () =>
    Effect.gen(function* () {
      const { fs, repo, run, config } = yield* fixture([]);
      const claudeRoot = `${repo}/.claude/worktrees`;
      const dead = `${claudeRoot}/dead`;
      // T3 names the folder after the project root.
      const deadManaged = `${config.worktreesDir}/${repo.split(/[\\/]/).at(-1)}/dead-managed`;
      const fresh = `${claudeRoot}/fresh`;
      const nestedClone = `${claudeRoot}/nested-clone`;
      const half = yield* addClaudeWorktree(repo, run, "half");
      for (const dir of [dead, deadManaged, fresh]) {
        yield* fs.makeDirectory(`${dir}/sub`, { recursive: true });
        yield* fs.writeFileString(`${dir}/sub/leftover.txt`, "x\n");
      }
      yield* fs.makeDirectory(`${nestedClone}/.git`, { recursive: true });
      // A delete that stopped partway: files remain, `.git` is gone, git still has the record.
      yield* fs.remove(`${half}/.git`);
      yield* fs.makeDirectory(`${repo}/.claude/other`, { recursive: true });
      const reaper = yield* reaperFor(repo, []);
      yield* touch(`${fresh}/sub`, -HOUR_MS);

      const report = yield* reaper.reap();

      for (const dir of [dead, deadManaged, half]) {
        expect(outcomeOf(report, dir)?.outcome).toBe("removed");
        expect(yield* fs.exists(dir)).toBe(false);
      }
      expect(outcomeOf(report, fresh)?.outcome).toBe("kept");
      expect(outcomeOf(report, fresh)?.reason).toContain("last 24 hours");
      for (const dir of [fresh, nestedClone, `${repo}/.claude/other`])
        expect(yield* fs.exists(dir)).toBe(true);
      expect(outcomeOf(report, nestedClone)?.outcome).not.toBe("removed");
      expect(yield* fs.exists(`${repo}/.git/worktrees/half`)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("previews dead folders and worktrees without removing them", () =>
    Effect.gen(function* () {
      const { fs, repo, run } = yield* fixture([]);
      const dead = `${repo}/.claude/worktrees/dead`;
      yield* fs.makeDirectory(dead, { recursive: true });
      const stale = yield* addClaudeWorktree(repo, run, "stale");
      const reaper = yield* reaperFor(repo, []);

      const report = yield* reaper.reap({ dryRun: true });

      expect(outcomeOf(report, dead)?.outcome).toBe("would_remove");
      expect(outcomeOf(report, stale)?.outcome).toBe("would_remove");
      expect(yield* fs.exists(dead)).toBe(true);
      expect(yield* fs.exists(stale)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("never judges the main checkout, or a checkout that is a project of its own", () =>
    Effect.gen(function* () {
      const { fs, repo, run } = yield* fixture([]);
      const own = yield* addClaudeWorktree(repo, run, "own-project");
      const reaper = yield* reaperFor(repo, [], { invalidated: [], extraProjectRoots: [own] });

      const report = yield* reaper.reap();

      expect(outcomeOf(report, repo)).toBeUndefined();
      expect(outcomeOf(report, own)?.outcome).toBe("kept");
      expect(yield* fs.exists(`${repo}/tracked.txt`)).toBe(true);
      expect(yield* fs.exists(own)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("reaps an idle thread's managed worktree and keeps the ones it must not", () =>
    Effect.gen(function* () {
      const { fs, repo, run, worktrees } = yield* fixture(["idle", "busy", "unrecorded"]);
      const claudeOwned = yield* addClaudeWorktree(repo, run, "claude-owned");
      const userThread = (name: string, worktreePath: string, overrides = {}) =>
        shell({
          id: ThreadId.make(`thread-${name}`),
          branch: name,
          worktreePath,
          createdBy: "user",
          creationSource: "web",
          lineage: {
            rootThreadId: ThreadId.make(`thread-${name}`),
            parentThreadId: null,
            relationshipToParent: null,
          },
          ...overrides,
        });
      const reaper = yield* reaperFor(repo, [
        userThread("idle", worktrees.idle!),
        userThread("busy", worktrees.busy!, { status: "running", activeRunId: "run-1" }),
        userThread("unrecorded", worktrees.unrecorded!, { branch: null }),
        userThread("claude-owned", claudeOwned),
      ]);

      const report = yield* reaper.reap();

      expect(outcomeOf(report, worktrees.idle!)?.outcome).toBe("removed");
      expect(outcomeOf(report, worktrees.busy!)?.outcome).toBe("kept");
      expect(outcomeOf(report, worktrees.unrecorded!)?.reason).toContain("no recorded branch");
      // T3 recreates only worktrees in its own folder, so a thread's .claude one must stay.
      expect(outcomeOf(report, claudeOwned)?.reason).toContain("cannot recreate");
      expect(yield* fs.exists(worktrees.idle!)).toBe(false);
      for (const dir of [worktrees.busy!, worktrees.unrecorded!, claudeOwned])
        expect(yield* fs.exists(dir)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
