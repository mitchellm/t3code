import type { Loadout, OrchestratorMcpDelegateTaskInput } from "@t3tools/contracts";

// Fork: roles that edit code. Explorers and judges only read, so a shared checkout is safe for
// them and a worktree would just cost a setup run.
const EDITING_ROLES: ReadonlyArray<string> = ["worker", "subPlanner"];

export type WorkerIsolationDecision = "explicit" | "default" | "shared";

/**
 * Whether a delegation gets its own worktree. An explicit `isolation` always wins ("none" and
 * "shared" opt out). Otherwise an editing role the thread's loadout assigns is isolated by
 * default, because parallel workers editing one checkout overwrite each other.
 *
 * "default" differs from "explicit" so the caller can fall back to the shared checkout when the
 * project is not a git repository, instead of failing a call that never asked for a worktree.
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
