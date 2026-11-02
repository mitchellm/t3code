import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

describe("reportSlowStatement", () => {
  const statement = { sql: "SELECT 1", durationMs: 250, connection: "writer" } as const;

  it("reports statements at or over the threshold and skips faster ones", () => {
    const reported: Array<SqliteClient.SlowSqliteStatement> = [];
    const options = {
      thresholdMs: 250,
      onSlow: (slow: SqliteClient.SlowSqliteStatement) => reported.push(slow),
    };
    SqliteClient.reportSlowStatement(options, { ...statement, durationMs: 249.9 });
    assert.deepStrictEqual(reported, []);
    SqliteClient.reportSlowStatement(options, statement);
    assert.deepStrictEqual(reported, [statement]);
  });

  it("does nothing without options and survives a throwing callback", () => {
    SqliteClient.reportSlowStatement(undefined, statement);
    SqliteClient.reportSlowStatement(
      {
        thresholdMs: 0,
        onSlow: () => {
          throw new Error("disk full");
        },
      },
      statement,
    );
  });

  it("truncates long SQL", () => {
    const reported: Array<SqliteClient.SlowSqliteStatement> = [];
    SqliteClient.reportSlowStatement(
      { thresholdMs: 0, onSlow: (slow) => reported.push(slow) },
      { ...statement, sql: "x".repeat(5_000) },
    );
    assert.strictEqual(reported[0]?.sql.length, 1001);
  });
});

describe("slow statement reporting on a real database", () => {
  const withClient = Effect.fn("withSlowStatementClient")(function* (
    reported: Array<SqliteClient.SlowSqliteStatement>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-slow-" });
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      reported.length = 0;
      yield* sql`INSERT INTO entries VALUES ('second')`;
      yield* sql`SELECT name FROM entries`.pipe(SqliteClient.readOnly);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(directory, "state.sqlite"),
          readerWorker: true,
          // Zero reports every statement so the test needs no slow query.
          slowStatement: { thresholdMs: 0, onSlow: (slow) => reported.push(slow) },
        }),
      ),
    );
  });

  it.effect("reports statements from the main connection and the reader worker", () =>
    Effect.gen(function* () {
      const reported: Array<SqliteClient.SlowSqliteStatement> = [];
      yield* withClient(reported).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
      const writer = reported.find((slow) => slow.sql.startsWith("INSERT INTO entries"));
      const reader = reported.find((slow) => slow.sql.startsWith("SELECT name FROM entries"));
      assert.strictEqual(writer?.connection, "writer");
      assert.strictEqual(reader?.connection, "reader");
      assert.isTrue((reader?.durationMs ?? -1) >= 0);
    }),
  );
});
