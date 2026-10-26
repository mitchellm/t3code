import type { Ledger, LedgerItem, LedgerItemStatus } from "@t3tools/contracts";
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
