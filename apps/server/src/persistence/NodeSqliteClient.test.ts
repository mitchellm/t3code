import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );

  it.effect("treats write-only statements as empty result sets", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const createRows = yield* sql`CREATE TABLE write_only(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      assert.deepStrictEqual(createRows, []);

      const insertRows = yield* sql`INSERT INTO write_only(name) VALUES (${"alpha"})`;
      assert.deepStrictEqual(insertRows, []);

      const updateRows = yield* sql`UPDATE write_only SET name = ${"beta"} WHERE id = ${1}`;
      assert.deepStrictEqual(updateRows, []);

      const deleteValues = yield* sql`DELETE FROM write_only WHERE id = ${1}`.values;
      assert.deepStrictEqual(deleteValues, []);
    }),
  );
});
