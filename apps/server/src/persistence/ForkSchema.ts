import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork-only schema, outside the numbered list: upstream reuses fork migration numbers, which fails
 * startup with BadState. Everything here is idempotent and runs right after upstream's migrations.
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

  // Scheduled-task prechecks and model overrides. SQLite has no ADD COLUMN IF NOT EXISTS.
  const scheduledTaskColumns = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`).map(
      (column) => column.name,
    ),
  );
  if (!scheduledTaskColumns.has("precheck_json")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN precheck_json TEXT`;
  }
  if (!scheduledTaskColumns.has("model_override_json")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN model_override_json TEXT`;
  }
  if (!scheduledTaskColumns.has("last_run_quiet")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_quiet INTEGER NOT NULL DEFAULT 0`;
  }
  if (!scheduledTaskColumns.has("quiet_run_count")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN quiet_run_count INTEGER NOT NULL DEFAULT 0`;
  }
});

/**
 * Migration ids the fork once held in the numbered list before upstream took the number. Each
 * one's schema now comes from ensureForkSchema, so its history row is released before migrating:
 * left in place, upstream's migration under that id would be skipped, and startup refuses that.
 */
const RETIRED_FORK_MIGRATIONS: ReadonlyArray<readonly [number, string]> = [
  [78, "ScheduledTaskPrecheck"],
];

export const releaseRetiredForkMigrations = Effect.fn("releaseRetiredForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  for (const [id, name] of RETIRED_FORK_MIGRATIONS) {
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id} AND name = ${name}`;
  }
});
