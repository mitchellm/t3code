import {
  type Loadout,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestratorMcpDelegateTaskInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

// Fork: roles that edit code. Explorers and judges only read, so a shared checkout is safe for
// them and a worktree would just cost a setup run.
const EDITING_ROLES: ReadonlyArray<string> = ["worker", "subPlanner"];

export type WorkerIsolationDecision = "explicit" | "default" | "shared";

/**
 * Whether a delegation gets its own worktree. An explicit `isolation` always wins ("none" and
 * "shared" opt out). Otherwise an editing role the loadout assigns is isolated by default.
 * "default" differs from "explicit" so a non-git project can fall back to the shared checkout
 * instead of failing a call that never asked for a worktree.
 */
export function workerIsolation(input: {
  readonly isolation: OrchestratorMcpDelegateTaskInput["isolation"];
  readonly role: OrchestratorMcpDelegateTaskInput["role"];
  readonly loadout: Pick<Loadout, "roles">;
}): WorkerIsolationDecision {
  if (input.isolation === "worktree") return "explicit";
  if (input.isolation !== undefined) return "shared";
  const { role } = input;
  if (role === undefined || !EDITING_ROLES.includes(role)) return "shared";
  return Object.hasOwn(input.loadout.roles, role) ? "default" : "shared";
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const NOT_A_GIT_REPOSITORY = /not a git repository/i;

/** A worktree that could not be made, and whether only because the project has no repository. */
class WorktreeUnavailable {
  readonly failure: OrchestratorMcpFailure;
  readonly notGitRepository: boolean;
  constructor(failure: OrchestratorMcpFailure, notGitRepository: boolean) {
    this.failure = failure;
    this.notGitRepository = notGitRepository;
  }
}

export interface DelegationWorkspace {
  readonly strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  readonly isolation: "worktree" | "shared";
  /** Set only when a defaulted worktree fell back to the shared checkout. */
  readonly note?: string;
}

/**
 * Decides and prepares a delegation's checkout: the base commit and the worktree strategy, or the
 * shared checkout. A defaulted worktree that cannot be made falls back, logged and reported.
 */
export const resolveDelegationWorkspace = Effect.fn("WorkerIsolation.resolveDelegationWorkspace")(
  function* <E>(input: {
    readonly delegation: Pick<OrchestratorMcpDelegateTaskInput, "isolation" | "role">;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly activeLoadout: Effect.Effect<Pick<Loadout, "roles">, E>;
    readonly requireProject: (
      projectId: ProjectId,
    ) => Effect.Effect<{ readonly workspaceRoot: string; readonly title: string }, E>;
    readonly git: Pick<GitVcsDriver.GitVcsDriver["Service"], "resolveCommit">;
  }) {
    const { delegation, thread, git } = input;
    const decision = workerIsolation({
      isolation: delegation.isolation,
      role: delegation.role,
      loadout:
        delegation.isolation === undefined && delegation.role !== undefined
          ? yield* input.activeLoadout
          : { roles: {} },
    });
    const shared: DelegationWorkspace = { strategy: undefined, isolation: "shared" };
    if (decision === "shared") return shared;

    const worktree = Effect.gen(function* () {
      const project = yield* input.requireProject(thread.projectId);
      const base = yield* git
        .resolveCommit({ cwd: thread.worktreePath ?? project.workspaceRoot, revision: "HEAD" })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorktreeUnavailable(
                invalid("Unable to resolve the parent checkout commit."),
                NOT_A_GIT_REPOSITORY.test(`${error.message} ${error.detail}`),
              ),
          ),
        );
      // Launch preparation creates the worktree from the project root, so a parent checkout in
      // another repository (such as a Git folder inside Scratch) would hand it a commit it
      // cannot find.
      if (thread.worktreePath !== null) {
        yield* git
          .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
          .pipe(
            Effect.mapError(
              () =>
                new WorktreeUnavailable(
                  invalid(
                    `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                  ),
                  false,
                ),
            ),
          );
      }
      return {
        strategy: { type: "worktree", baseRef: base.commitSha, startFromOrigin: false },
        isolation: "worktree",
      } satisfies DelegationWorkspace;
    });
    const asFailure = Effect.mapError((error: E | WorktreeUnavailable) =>
      error instanceof WorktreeUnavailable ? error.failure : error,
    );
    if (decision === "explicit") return yield* worktree.pipe(asFailure);
    // Only a missing repository falls back; any other failure is a real problem to surface.
    return yield* worktree.pipe(
      Effect.catchIf(
        (error): error is WorktreeUnavailable & { readonly notGitRepository: true } =>
          error instanceof WorktreeUnavailable && error.notGitRepository,
        (error) =>
          Effect.logInfo("delegate_task.default-worktree-fallback", {
            error: error.failure,
          }).pipe(
            Effect.as({
              ...shared,
              note: "This project is not a git repository, so the child shares your checkout.",
            } satisfies DelegationWorkspace),
          ),
      ),
      asFailure,
    );
  },
);

/** The result fields that tell the parent which checkout the child got. */
export const isolationReport = (
  workspace: DelegationWorkspace | undefined,
): { isolation?: "worktree" | "shared"; isolationNote?: string } =>
  workspace === undefined
    ? {}
    : {
        isolation: workspace.isolation,
        ...(workspace.note === undefined ? {} : { isolationNote: workspace.note }),
      };
