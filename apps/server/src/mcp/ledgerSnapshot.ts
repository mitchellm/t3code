import type { Ledger, LedgerMcpSnapshot } from "@t3tools/contracts";
import {
  orderLedgerTree,
  releasedLedgerItemIds,
  unreleasedBlockers,
} from "@t3tools/shared/taskLedger";

/**
 * The compact ledger view every ledger tool result carries. Items come in tree order with a
 * depth rather than nested, so a ledger of thousands stays one flat, scannable list.
 */
export function snapshotLedger(ledger: Ledger): LedgerMcpSnapshot {
  const counts = { open: 0, in_progress: 0, closed: 0, dropped: 0, deferred: 0 };
  for (const item of ledger.items) counts[item.status] += 1;
  const released = releasedLedgerItemIds(ledger);
  return {
    ledgerId: ledger.id,
    title: ledger.title,
    startState: ledger.startState,
    winConditions: ledger.winConditions,
    closed: ledger.closedAt !== null,
    requiresJudge: ledger.requiresJudge === true,
    counts,
    unfinished: counts.open + counts.in_progress,
    checkpoints: ledger.checkpoints.map(({ id, title, reached }) => ({ id, title, reached })),
    items: orderLedgerTree(ledger.items).map(({ item, depth }) => ({
      id: item.id,
      title: item.title,
      acceptance: item.acceptance,
      status: item.status,
      depth,
      parentItemId: item.parentItemId ?? null,
      blockedBy: item.blockedBy ?? [],
      waitingOn: unreleasedBlockers(item, released),
      evidence: item.evidence,
      dropReason: item.dropReason,
      deferReason: item.deferReason ?? null,
      judging: item.judging === true,
      verdict: item.verdict?.outcome ?? null,
      verdictNotes: item.verdict?.notes ?? null,
      judgeError: item.judgeError ?? null,
      judgements: item.judgements ?? 0,
    })),
  };
}
