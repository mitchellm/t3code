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

  yield* ensureTurnItemCounts(sql);
});

/**
 * Shell reads sum these per-(thread, run) counters instead of counting turn items, which took
 * minutes on a large database. Triggers keep them in the writer's transaction, so the upsert that
 * moves an item between runs, raw SQL and any retention delete are all covered. `INSERT OR
 * REPLACE` would skip the delete trigger (recursive triggers are off); the projection only upserts.
 */
const ensureTurnItemCounts = Effect.fn("ensureTurnItemCounts")(function* (
  sql: SqlClient.SqlClient,
) {
  const existing = yield* sql`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'orchestration_v2_projection_turn_item_counts'
  `;
  // The backfill and the triggers land together: a counter table without triggers would drift.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS orchestration_v2_projection_turn_item_counts (
          thread_id TEXT NOT NULL,
          -- '' stands for items without a run: NULL in a key would let one key hold several rows.
          run_id TEXT NOT NULL,
          item_count INTEGER NOT NULL,
          PRIMARY KEY (thread_id, run_id)
        ) WITHOUT ROWID
      `;
      if (existing.length === 0) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_id, item_count)
          SELECT thread_id, COALESCE(run_id, ''), COUNT(*)
          FROM orchestration_v2_projection_turn_items
          GROUP BY thread_id, run_id
        `;
      }
      yield* sql`
        CREATE TRIGGER IF NOT EXISTS orchestration_v2_turn_item_counts_insert
        AFTER INSERT ON orchestration_v2_projection_turn_items
        BEGIN
          INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_id, item_count)
          VALUES (new.thread_id, COALESCE(new.run_id, ''), 1)
          ON CONFLICT (thread_id, run_id)
          DO UPDATE SET item_count = orchestration_v2_projection_turn_item_counts.item_count + 1;
        END
      `;
      // The upsert rewrites thread_id and run_id on every streamed update; only a real move counts.
      yield* sql`
        CREATE TRIGGER IF NOT EXISTS orchestration_v2_turn_item_counts_move
        AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items
        WHEN old.thread_id IS NOT new.thread_id OR old.run_id IS NOT new.run_id
        BEGIN
          UPDATE orchestration_v2_projection_turn_item_counts
          SET item_count = item_count - 1
          WHERE thread_id = old.thread_id AND run_id = COALESCE(old.run_id, '');
          DELETE FROM orchestration_v2_projection_turn_item_counts
          WHERE thread_id = old.thread_id AND run_id = COALESCE(old.run_id, '') AND item_count <= 0;
          INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_id, item_count)
          VALUES (new.thread_id, COALESCE(new.run_id, ''), 1)
          ON CONFLICT (thread_id, run_id)
          DO UPDATE SET item_count = orchestration_v2_projection_turn_item_counts.item_count + 1;
        END
      `;
      yield* sql`
        CREATE TRIGGER IF NOT EXISTS orchestration_v2_turn_item_counts_delete
        AFTER DELETE ON orchestration_v2_projection_turn_items
        BEGIN
          UPDATE orchestration_v2_projection_turn_item_counts
          SET item_count = item_count - 1
          WHERE thread_id = old.thread_id AND run_id = COALESCE(old.run_id, '');
          DELETE FROM orchestration_v2_projection_turn_item_counts
          WHERE thread_id = old.thread_id AND run_id = COALESCE(old.run_id, '') AND item_count <= 0;
        END
      `;
    }),
  );
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
