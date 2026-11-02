import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("078_ScheduledTaskPrecheck", (it) => {
  it.effect("keeps existing scheduled tasks with no precheck, no override and no quiet runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
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
      })}`;
      yield* runMigrations({ toMigrationInclusive: 78 });

      const rows = yield* sql<{
        task_id: string;
        precheck_json: string | null;
        model_override_json: string | null;
        last_run_quiet: number;
        quiet_run_count: number;
      }>`SELECT task_id, precheck_json, model_override_json, last_run_quiet, quiet_run_count FROM scheduled_tasks`;
      assert.deepEqual(rows, [
        {
          task_id: "existing",
          precheck_json: null,
          model_override_json: null,
          last_run_quiet: 0,
          quiet_run_count: 0,
        },
      ]);
    }),
  );
});
