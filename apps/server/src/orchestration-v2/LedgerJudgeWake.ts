import type { Ledger, NodeId } from "@t3tools/contracts";
import { partitionLedgerFollowUp } from "@t3tools/shared/taskLedger";

import { answerWouldPass } from "../mcp/LedgerJudgement.ts";

const isOpen = (item: Ledger["items"][number]) =>
  item.status === "open" || item.status === "in_progress";

/**
 * Whether a finished judge task wakes the planner: a fail always, a pass only when it finishes
 * the ledger, unblocks work, or leaves an idle planner something to do. The verdict is recorded
 * either way. Anything this cannot place as a pass wakes, as before.
 */
export function judgeVerdictWakesPlanner(input: {
  readonly ledger: Ledger | undefined;
  readonly taskId: NodeId;
  readonly answer: string | null;
  /** A turn is running or queued on the thread, so auto-continue reaches the planner after it. */
  readonly plannerBusy: boolean;
}): boolean {
  const { ledger } = input;
  const judged = ledger?.items.find(
    (item) => item.judging === true && item.judgeTaskId === input.taskId,
  );
  if (
    ledger === undefined ||
    judged === undefined ||
    !answerWouldPass(ledger, judged, input.answer)
  ) {
    return true;
  }
  const others = ledger.items.filter((item) => item.id !== judged.id && isOpen(item));
  // The pass finishes the ledger: the planner owes the solve and report.
  if (others.length === 0) return true;
  // The pass unblocks an item, or lets its parent close.
  if (others.some((item) => item.blockedBy?.includes(judged.id) === true)) return true;
  if (others.some((item) => item.id === judged.parentItemId)) return true;
  if (input.plannerBusy) return false;
  // An idle planner with nothing else to wake it must be told there is work left.
  return partitionLedgerFollowUp(ledger, others).actionable.length > 0;
}
