// Fork: the ledger summary that rides on the thread shell, so list screens never open a thread
// detail stream just to draw "3/7".
import type { Ledger, LedgerProgress, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

function progressFromCounts(closed: number, open: number): LedgerProgress | null {
  const total = closed + open;
  return total === 0 ? null : { closed, open, total };
}

/**
 * Dropped and deferred items are out of the task's scope, so they leave the total. Null when there
 * is nothing to measure.
 */
export function summarizeLedgerProgress(ledger: Ledger | undefined): LedgerProgress | null {
  if (ledger === undefined) return null;
  let closed = 0;
  let open = 0;
  for (const item of ledger.items) {
    if (item.status === "closed") closed += 1;
    else if (item.status === "open" || item.status === "in_progress") open += 1;
  }
  return progressFromCounts(closed, open);
}

export interface LedgerProgressRow {
  readonly thread_id: string;
  readonly closed: number;
  readonly open: number;
}

/**
 * Counts item statuses in SQL so the shell never decodes a ledger document: this runs for every
 * running thread's shell refresh. Call it in the read step of a shell read, where the caller's
 * read-only transaction covers it; `ledgerProgressByThread` then needs no database.
 */
export const selectLedgerProgressRows = (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<ThreadId>,
) =>
  threadIds.length === 0
    ? Effect.succeed([] as ReadonlyArray<LedgerProgressRow>)
    : sql<LedgerProgressRow>`
        SELECT l.thread_id AS thread_id,
          COALESCE(SUM(CASE WHEN json_extract(item.value, '$.status') = 'closed' THEN 1 ELSE 0 END), 0)
            AS closed,
          COALESCE(
            SUM(CASE WHEN json_extract(item.value, '$.status') IN ('open', 'in_progress') THEN 1 ELSE 0 END),
            0
          ) AS open
        FROM orchestration_v2_projection_ledgers l, json_each(l.payload_json, '$.items') item
        WHERE l.thread_id IN ${sql.in(threadIds)}
        GROUP BY l.thread_id
      `;

/** Threads without a ledger, or with nothing to measure, are absent from the map. */
export function ledgerProgressByThread(
  rows: ReadonlyArray<LedgerProgressRow>,
): ReadonlyMap<ThreadId, LedgerProgress> {
  const progress = new Map<ThreadId, LedgerProgress>();
  for (const row of rows) {
    const summary = progressFromCounts(row.closed, row.open);
    if (summary !== null) progress.set(row.thread_id as ThreadId, summary);
  }
  return progress;
}
