// Fork: the Overview screen's derivation. Pure over thread shells the client already holds.
import { RETRO_THREAD_ID_PREFIX } from "@t3tools/contracts";

import { isThreadWorking } from "./threadInbox.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";

export type OverviewShellInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "title"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "runtime"
  | "loadout"
  | "ledgerProgress"
  | "itemCount"
  | "updatedAt"
> &
  Partial<
    Pick<
      EnvironmentThreadShell,
      "hasActionableProposedPlan" | "interactionMode" | "latestRun" | "hasWorkingSubagents"
    >
  >;

export type OverviewNow = "waiting" | "judging" | "running" | "idle";

export interface ThreadOverviewRow {
  readonly threadId: OverviewShellInput["id"];
  readonly environmentId: OverviewShellInput["environmentId"];
  readonly projectId: OverviewShellInput["projectId"];
  readonly title: string;
  readonly now: OverviewNow;
  /** Null while the thread runs solo; the caller resolves it against its settings. */
  readonly loadoutId: string | null;
  /** Null when the thread has no ledger or an empty one; dropped items are out of `total`. */
  readonly ledger: { readonly closed: number; readonly total: number } | null;
  readonly itemCount: number;
  readonly updatedAt: string;
}

/** Judge delegations are titled `Judge <item>: ...` (LedgerJudgement.ts); no thread field marks them. */
const JUDGE_TITLE_PREFIX = "Judge ";

const NOW_ORDER: Record<OverviewNow, number> = { waiting: 0, judging: 1, running: 2, idle: 3 };

function isWorkingShell(shell: OverviewShellInput): boolean {
  return isThreadWorking({
    hasActionableProposedPlan: shell.hasActionableProposedPlan ?? false,
    hasPendingApprovals: shell.hasPendingApprovals,
    hasPendingUserInput: shell.hasPendingUserInput,
    pendingSubagentRequest: shell.pendingSubagentRequest ?? null,
    interactionMode: shell.interactionMode ?? "default",
    latestRun: shell.latestRun ?? null,
    runtime: shell.runtime,
  });
}

function isLiveRuntime(shell: OverviewShellInput): boolean {
  return threadRuntimeIsActive(shell.runtime);
}

export function deriveThreadOverviewRows(
  shells: ReadonlyArray<OverviewShellInput>,
): ReadonlyArray<ThreadOverviewRow> {
  const judgingParents = new Set<string>();
  for (const shell of shells) {
    const parent = shell.lineage.parentThreadId;
    if (
      parent !== null &&
      shell.lineage.relationshipToParent === "subagent" &&
      shell.archivedAt === null &&
      shell.deletedAt === null &&
      shell.title.startsWith(JUDGE_TITLE_PREFIX) &&
      isLiveRuntime(shell)
    ) {
      judgingParents.add(`${shell.environmentId}|${parent}`);
    }
  }

  const rows: Array<ThreadOverviewRow> = [];
  for (const shell of shells) {
    if (shell.archivedAt !== null || shell.deletedAt !== null) continue;
    if (shell.lineage.relationshipToParent === "subagent") continue;
    if (shell.id.startsWith(RETRO_THREAD_ID_PREFIX)) continue;
    // A plan the agent finished proposing is waiting on the user, as the inbox treats it.
    const planReady =
      shell.interactionMode === "plan" &&
      shell.hasActionableProposedPlan === true &&
      !isLiveRuntime(shell);
    const now: OverviewNow =
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      (shell.pendingSubagentRequest ?? null) !== null ||
      planReady
        ? "waiting"
        : judgingParents.has(`${shell.environmentId}|${shell.id}`)
          ? "judging"
          : isWorkingShell(shell) && (isLiveRuntime(shell) || shell.hasWorkingSubagents === true)
            ? "running"
            : "idle";
    rows.push({
      threadId: shell.id,
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      title: shell.title,
      now,
      loadoutId: shell.loadout?.id ?? null,
      ledger:
        shell.ledgerProgress == null || shell.ledgerProgress.total === 0
          ? null
          : { closed: shell.ledgerProgress.closed, total: shell.ledgerProgress.total },
      itemCount: shell.itemCount,
      updatedAt: shell.updatedAt,
    });
  }
  return [...rows].sort(
    (left, right) =>
      NOW_ORDER[left.now] - NOW_ORDER[right.now] ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.threadId.localeCompare(right.threadId),
  );
}

/** `total` already leaves dropped items out. */
export function ledgerBarFraction(progress: {
  readonly total: number;
  readonly closed: number;
}): number {
  return progress.total <= 0 ? 0 : progress.closed / progress.total;
}
