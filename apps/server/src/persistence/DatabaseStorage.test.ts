import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    assert.isAbove(yield* freePages, 0);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("calls the writer idle only after a quiet window with no row changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE events (value TEXT)`;
    const idle = yield* DatabaseStorage.makeWriterIdleGate(Duration.minutes(2));

    // A server that just started has not been quiet yet.
    assert.isFalse(yield* idle);
    yield* TestClock.adjust(Duration.minutes(1));
    assert.isFalse(yield* idle);
    yield* TestClock.adjust(Duration.minutes(1));
    assert.isTrue(yield* idle);

    // A write restarts the window; reads do not.
    yield* sql`INSERT INTO events VALUES ('write')`;
    assert.isFalse(yield* idle);
    yield* TestClock.adjust(Duration.minutes(1));
    yield* sql`SELECT * FROM events`;
    assert.isFalse(yield* idle);
    yield* TestClock.adjust(Duration.minutes(1));
    assert.isTrue(yield* idle);

    // A burst keeps it busy however long it lasts.
    for (let write = 0; write < 3; write++) {
      yield* sql`INSERT INTO events VALUES ('burst')`;
      yield* TestClock.adjust(Duration.seconds(90));
      assert.isFalse(yield* idle);
    }
    yield* TestClock.adjust(Duration.minutes(2));
    assert.isTrue(yield* idle);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("reclaims pages only while the writer is idle and stops when a write lands", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    const freed = yield* freePages;
    assert.isAbove(freed, 8);
    const idle = yield* DatabaseStorage.makeWriterIdleGate(Duration.minutes(2));

    // Straight after the writes above, nothing is reclaimed.
    assert.equal(yield* DatabaseStorage.reclaimFreePages(sql, 1024, idle), 0);
    assert.equal(yield* freePages, freed);

    // Quiet for the window: a write after the third page ends the pass.
    yield* TestClock.adjust(Duration.minutes(2));
    let asked = 0;
    const idleUntilWrite = Effect.gen(function* () {
      asked += 1;
      if (asked === 4) yield* sql`INSERT INTO retained VALUES ('late')`;
      return yield* idle;
    });
    assert.equal(yield* DatabaseStorage.reclaimFreePages(sql, 1024, idleUntilWrite), 3);
    assert.isAbove(yield* freePages, 0);

    // The write restarted the window; once it passes the rest is returned.
    assert.equal(yield* DatabaseStorage.reclaimFreePages(sql, 1024, idle), 0);
    yield* TestClock.adjust(Duration.minutes(2));
    assert.isAbove(yield* DatabaseStorage.reclaimFreePages(sql, 1024, idle), 0);
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "late" }]);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

const compactionLayer = (
  pruneEventStore: ProjectionMaintenance.ProjectionMaintenanceV2["Service"]["pruneEventStore"],
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
        pruneEventStore,
      }),
    ),
    Layer.provide(Sqlite.layerMemory),
  );

const minute = 60_000;
const startupTime = Date.UTC(2026, 9, 19);
const emptyCompaction = { deletedEventCount: 0, deletedReceiptCount: 0, reclaimableBytes: 0 };

it.effect("remembers completion only after the paced pass finishes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    const betweenPagesReached = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const timestampWritten = yield* Deferred.make<void>();
    const compact = (betweenPages: Effect.Effect<void> = Effect.void) =>
      Effect.gen(function* () {
        yield* Effect.sleep(30);
        yield* Deferred.succeed(betweenPagesReached, undefined);
        yield* betweenPages;
        yield* Deferred.succeed(completed, undefined);
        return emptyCompaction;
      });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(minute);
      yield* TestClock.adjust(30);
      yield* Deferred.await(betweenPagesReached);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(269);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(1);
      yield* Deferred.await(timestampWritten);
      assert.isTrue(yield* Deferred.isDone(completed));
      assert.equal(Number(yield* fs.readFileString(timestampPath)), startupTime + minute + 300);
    }).pipe(
      Effect.provide(compactionLayer(compact)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, content, options) =>
          fs
            .writeFileString(file, content, options)
            .pipe(Effect.ensuring(Deferred.succeed(timestampWritten, undefined))),
      }),
    );
  }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);
