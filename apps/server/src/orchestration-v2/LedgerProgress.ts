// Fork: the ledger summary that rides on the thread shell, so list screens never open a thread
// detail stream just to draw "3/7".
import { LedgerJson, type Ledger, type LedgerProgress, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/** Dropped items are set aside, so they leave the total. Null when there is nothing to measure. */
export function summarizeLedgerProgress(ledger: Ledger | undefined): LedgerProgress | null {
  if (ledger === undefined) return null;
  let closed = 0;
  let open = 0;
  for (const item of ledger.items) {
    if (item.status === "closed") closed += 1;
    else if (item.status === "open" || item.status === "in_progress") open += 1;
  }
  const total = closed + open;
  return total === 0 ? null : { closed, open, total };
}

const decodeLedgerPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerJson));

/**
 * Takes the store's own client so the shell reads stay in its transaction and context. Threads
 * without a stored ledger, or with nothing to measure, are absent from the map.
 */
export const readLedgerProgressByThread = Effect.fn("LedgerProgress.readByThread")(function* (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<ThreadId>,
) {
  const progress = new Map<ThreadId, LedgerProgress>();
  if (threadIds.length === 0) return progress;
  const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
    SELECT thread_id, payload_json FROM orchestration_v2_projection_ledgers
    WHERE thread_id IN ${sql.in(threadIds)}
  `;
  for (const row of rows) {
    const summary = summarizeLedgerProgress(yield* decodeLedgerPayload(row.payload_json));
    if (summary !== null) progress.set(row.thread_id as ThreadId, summary);
  }
  return progress;
});
