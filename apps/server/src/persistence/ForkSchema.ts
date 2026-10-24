import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork: tables that only this fork has. They live outside the numbered migration list because the
 * migrator keys by number and upstream will eventually take the same number for a different
 * migration, which fails startup with BadState. Everything here is idempotent and runs right after
 * upstream's migrations. A table that is upstreamed gets a real migration number at that point.
 * Append new fork tables to this function.
 */
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;

  // No backfill: ledger events did not exist before this table, so replay fills it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_ledgers (
      thread_id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- Open plus in_progress items, so "does this thread have unfinished work" needs no JSON.
      open_item_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL
    )
  `;
});
