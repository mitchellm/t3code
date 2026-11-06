import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "./ForkSchema.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("creates fork tables outside the numbered list and tolerates repeat runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const forkTables = sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('orchestration_v2_projection_ledgers', 'thread_task_retros')
        UNION ALL
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_thread_task_retros_project'
      `;
      yield* runMigrations();
      assert.strictEqual((yield* forkTables).length, 3);
      assert.deepStrictEqual(yield* history, migrationManifest);

      yield* ensureForkSchema();
      yield* ensureForkSchema();
      yield* runMigrations();
      assert.strictEqual((yield* forkTables).length, 3);
      assert.deepStrictEqual(yield* history, migrationManifest);
      const precheckColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('scheduled_tasks')
        WHERE name IN ('precheck_json', 'model_override_json', 'last_run_quiet', 'quiet_run_count')
      `;
      assert.strictEqual(precheckColumns.length, 4);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("backfills the turn item counters once, then leaves them to the triggers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // A database from before the counters: it has items but neither the table nor its triggers.
      for (const trigger of ["insert", "move", "delete"]) {
        yield* sql.unsafe(`DROP TRIGGER orchestration_v2_turn_item_counts_${trigger}`);
      }
      yield* sql`DROP TABLE orchestration_v2_projection_turn_item_counts`;
      const addItem = (id: string, threadId: string, runId: string | null) => sql`
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, ${runId}, 1, 'assistant_message', 'completed', '2026-11-06T00:00:00.000Z', '{}')
      `;
      yield* addItem("a", "thread:1", "run:1");
      yield* addItem("b", "thread:1", "run:1");
      yield* addItem("c", "thread:1", null);
      yield* addItem("d", "thread:2", "run:2");
      const counters = sql`
        SELECT thread_id, run_id, item_count
        FROM orchestration_v2_projection_turn_item_counts ORDER BY thread_id, run_id
      `;
      const expected = [
        { thread_id: "thread:1", run_id: "", item_count: 1 },
        { thread_id: "thread:1", run_id: "run:1", item_count: 2 },
        { thread_id: "thread:2", run_id: "run:2", item_count: 1 },
      ];

      yield* ensureForkSchema();
      assert.deepStrictEqual(yield* counters, expected);

      // A second start finds the table and must neither fail nor count the items again.
      yield* ensureForkSchema();
      assert.deepStrictEqual(yield* counters, expected);

      yield* addItem("e", "thread:2", "run:2");
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'c'`;
      assert.deepStrictEqual(yield* counters, [
        { thread_id: "thread:1", run_id: "run:1", item_count: 2 },
        { thread_id: "thread:2", run_id: "run:2", item_count: 2 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database that recorded the fork's old migration 78", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      // What the fork build's numbered 078_ScheduledTaskPrecheck left behind.
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN precheck_json TEXT`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN model_override_json TEXT`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_quiet INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN quiet_run_count INTEGER NOT NULL DEFAULT 0`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (78, 'ScheduledTaskPrecheck')
      `;
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: "existing",
        title: "task",
        prompt: "Run",
        enabled: 1,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: "project",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 3,
        precheck_json: '{"command":"git fetch --dry-run"}',
      })}`;

      const executed = yield* runMigrations();

      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [78, 79],
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(
        yield* sql<{ readonly precheck_json: string | null }>`
          SELECT precheck_json FROM scheduled_tasks
        `,
        [{ precheck_json: '{"command":"git fetch --dry-run"}' }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
