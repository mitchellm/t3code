import type {
  Ledger,
  LedgerItem,
  LedgerMcpSnapshot,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  orderLedgerTree,
  releasedLedgerItemIds,
  unreleasedBlockers,
} from "@t3tools/shared/taskLedger";

export type LedgerTaskStatusRecord = Pick<OrchestrationV2Subagent, "id" | "status">;

/** Fork: the item's linked tasks with each one's status read live from the thread's tasks. */
function snapshotTasks(
  item: LedgerItem,
  statusOf: ReadonlyMap<string, OrchestrationV2Subagent["status"]>,
) {
  if (item.tasks === undefined || item.tasks.length === 0) return {};
  return {
    tasks: item.tasks.map((task) => ({
      taskId: task.taskId,
      role: task.role ?? null,
      model: task.model,
      status: statusOf.get(task.taskId) ?? null,
      childThreadId: task.childThreadId,
    })),
  };
}

/** Fork: the thread's task records are read only when some item links a task. */
export const ledgerLinksTasks = (ledger: Ledger) =>
  ledger.items.some((item) => (item.tasks?.length ?? 0) > 0);

/**
 * The compact ledger view every ledger tool result carries. Items come in tree order with a
 * depth rather than nested, so a ledger of thousands stays one flat, scannable list. `onlyItemIds`
 * keeps just those items (still with their tree depth and ledger-wide blockers) for a write's
 * result, so one update does not echo the whole ledger back into the agent's context.
 */
export function snapshotLedger(
  ledger: Ledger,
  taskRecords: ReadonlyArray<LedgerTaskStatusRecord> = [],
  onlyItemIds?: ReadonlyArray<string>,
): LedgerMcpSnapshot {
  const counts = { open: 0, in_progress: 0, closed: 0, dropped: 0, deferred: 0 };
  for (const item of ledger.items) counts[item.status] += 1;
  const released = releasedLedgerItemIds(ledger);
  const statusOf = new Map(taskRecords.map(({ id, status }) => [id as string, status]));
  const shown = onlyItemIds === undefined ? undefined : new Set<string>(onlyItemIds);
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
    ...(shown === undefined ? {} : { changedOnly: true as const }),
    items: orderLedgerTree(ledger.items)
      .filter(({ item }) => shown === undefined || shown.has(item.id))
      .map(({ item, depth }) => ({
        id: item.id,
        title: item.title,
        acceptance: item.acceptance,
        ...(item.quote === undefined ? {} : { quote: item.quote }),
        status: item.status,
        depth,
        parentItemId: item.parentItemId ?? null,
        blockedBy: item.blockedBy ?? [],
        waitingOn: unreleasedBlockers(item, released),
        evidence: item.evidence,
        dropReason: item.dropReason,
        deferReason: item.deferReason ?? null,
        judging: item.judging === true,
        ...(item.setAside === undefined ? {} : { setAside: item.setAside }),
        verdict: item.verdict?.outcome ?? null,
        verdictNotes: item.verdict?.notes ?? null,
        judgeError: item.judgeError ?? null,
        judgements: item.judgements ?? 0,
        ...snapshotTasks(item, statusOf),
      })),
  };
}
