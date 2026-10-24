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

  // One row per thread, outside the event log: a retro is derived analysis that a person can run
  // again, so it neither needs replay nor belongs in the per-event thread payload. project_id and
  // created_at are columns so the zoomed-out rollup filters without decoding every document.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_task_retros (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retro_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_task_retros_project
    ON thread_task_retros(project_id, created_at)
  `;
});
