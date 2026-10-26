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
    const now: OverviewNow =
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      (shell.pendingSubagentRequest ?? null) !== null
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

const RECENT_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * The ledger lives in the thread's detail stream, not the shell, so reading it opens one
 * subscription per row. Only threads someone is likely watching pay that cost.
 */
export function shouldLoadOverviewLedger(
  row: Pick<ThreadOverviewRow, "now" | "updatedAt">,
  nowMs: number,
): boolean {
  if (row.now !== "idle") return true;
  const updated = Date.parse(row.updatedAt);
  return Number.isFinite(updated) && nowMs - updated < RECENT_IDLE_MS;
}

/** Dropped items leave the denominator, matching `formatLedgerProgress`. */
export function ledgerBarFraction(progress: {
  readonly total: number;
  readonly closed: number;
  readonly dropped: number;
}): number {
  const scope = progress.total - progress.dropped;
  return scope <= 0 ? 0 : progress.closed / scope;
}
