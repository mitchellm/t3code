import type {
  Ledger,
  LedgerItem,
  LedgerItemStatus,
  LedgerItemTask,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  orderLedgerTree,
  releasedLedgerItemIds,
  unreleasedBlockers,
} from "@t3tools/shared/taskLedger";

export interface LedgerProgress {
  readonly total: number;
  readonly closed: number;
  readonly dropped: number;
  readonly deferred: number;
  /** Items in scope for this task: everything but dropped and deferred. */
  readonly scope: number;
  /** Items still to do, which is what the server's auto-continue keeps working on. */
  readonly remaining: number;
  /** The ledger has unfinished work: not closed, and an item is open or in progress. */
  readonly active: boolean;
}

export const LEDGER_ITEM_STATUS_LABELS: Record<LedgerItemStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  closed: "Done",
  dropped: "Dropped",
  deferred: "Deferred",
};

/** The status label, except an item the server is judging reads as that. */
export function ledgerItemStatusLabel(item: Pick<LedgerItem, "status" | "judging">): string {
  return item.judging === true ? "Judging" : LEDGER_ITEM_STATUS_LABELS[item.status];
}

export function deriveLedgerProgress(ledger: Ledger): LedgerProgress {
  const counts: Record<LedgerItemStatus, number> = {
    open: 0,
    in_progress: 0,
    closed: 0,
    dropped: 0,
    deferred: 0,
  };
  for (const item of ledger.items) counts[item.status] += 1;
  const remaining = counts.open + counts.in_progress;
  return {
    total: ledger.items.length,
    closed: counts.closed,
    dropped: counts.dropped,
    deferred: counts.deferred,
    scope: ledger.items.length - counts.dropped - counts.deferred,
    remaining,
    active: ledger.closedAt === null && remaining > 0,
  };
}

/**
 * Dropped and deferred items are out of the denominator: they were set aside, so "5 of 7 done"
 * stays reachable when one of eight was dropped.
 */
export function formatLedgerProgress(progress: LedgerProgress): string {
  if (progress.total === 0) return "No items yet";
  const setAside = [
    progress.dropped > 0 ? `${progress.dropped} dropped` : null,
    progress.deferred > 0 ? `${progress.deferred} deferred` : null,
  ].filter((part) => part !== null);
  if (progress.scope === 0) {
    return progress.deferred === 0 ? `All ${progress.dropped} dropped` : setAside.join(" · ");
  }
  return [`${progress.closed} of ${progress.scope} done`, ...setAside].join(" · ");
}

type LedgerTaskRecord = Pick<
  OrchestrationV2Subagent,
  "id" | "status" | "result" | "startedAt" | "completedAt"
>;

export interface LedgerItemTaskRow {
  readonly task: LedgerItemTask;
  /** Live from the thread's task record; null once that record is gone. */
  readonly status: OrchestrationV2Subagent["status"] | null;
  /** The task's final report, once it has one. */
  readonly report: string | null;
  readonly startedAt: OrchestrationV2Subagent["startedAt"];
  readonly completedAt: OrchestrationV2Subagent["completedAt"];
}

/**
 * Fork: the agents that worked an item, in link order. The ledger stores only the link, so status
 * and report come from the thread projection's `subagents`, which the stream keeps current.
 */
export function deriveLedgerItemTasks(
  item: Pick<LedgerItem, "tasks">,
  subagents: ReadonlyArray<LedgerTaskRecord>,
): ReadonlyArray<LedgerItemTaskRow> {
  if (item.tasks === undefined || item.tasks.length === 0) return [];
  const byId = new Map(subagents.map((record) => [record.id as string, record]));
  return item.tasks.map((task) => {
    const record = byId.get(task.taskId);
    return {
      task,
      status: record?.status ?? null,
      report: record?.result ?? null,
      startedAt: record?.startedAt ?? null,
      completedAt: record?.completedAt ?? null,
    };
  });
}

export interface LedgerViewRow {
  readonly item: LedgerItem;
  /** Nesting below the top level; 0 for a top-level item. */
  readonly depth: number;
  /** Blockers not yet closed or dropped, so the row shows what it waits on. */
  readonly blockedBy: ReadonlyArray<LedgerItem["id"]>;
}

export interface LedgerView {
  /** Every item but deferred ones, depth first: each parent followed by its sub-items. */
  readonly rows: ReadonlyArray<LedgerViewRow>;
  readonly deferred: ReadonlyArray<LedgerItem>;
}

/**
 * The ledger as the panel lays it out. A sub-item whose parent is missing or deferred is lifted
 * to the top level so it stays visible with the work in scope.
 */
export function deriveLedgerView(ledger: Ledger): LedgerView {
  const released = releasedLedgerItemIds(ledger);
  const inScope = ledger.items.filter((item) => item.status !== "deferred");
  return {
    rows: orderLedgerTree(inScope).map(({ item, depth }) => ({
      item,
      depth,
      blockedBy: unreleasedBlockers(item, released),
    })),
    deferred: ledger.items.filter((item) => item.status === "deferred"),
  };
}
