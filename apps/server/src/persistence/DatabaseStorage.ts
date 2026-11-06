import type { DatabaseStorageStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { resolveHostCliCommand } from "../cli/invocation.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { forkParked } from "../serverActivation.ts";

const RECLAIM_PAGES_PER_PASS = 1024;
const RECLAIM_INTERVAL = Duration.minutes(1);
// Chat traffic writes every few hundred milliseconds, so a quiet writer means nobody is waiting on it.
const RECLAIM_WRITER_IDLE = Duration.minutes(2);
const COMPACTION_INTERVAL = Duration.hours(6);

/**
 * Whether the writer has changed no rows for `idleFor`. The first sample counts as activity: the
 * server has just migrated, and a restart is the likeliest time for a burst of reconnecting
 * clients. Writes between two samples are dated to the later one, which only delays reclaiming.
 * `total_changes()` counts the connection's own row changes, triggers included, and no reads.
 */
export const makeWriterIdleGate = Effect.fn("DatabaseStorage.makeWriterIdleGate")(function* (
  idleFor: Duration.Duration,
) {
  const sql = yield* SqlClient.SqlClient;
  const idleForMs = Duration.toMillis(idleFor);
  let changes: number | undefined;
  let lastActiveAt = 0;
  return Effect.gen(function* () {
    const rows = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    const now = yield* Clock.currentTimeMillis;
    const current = rows[0]?.changes;
    if (changes === undefined || current !== changes) lastActiveAt = now;
    changes = current;
    return now - lastActiveAt >= idleForMs;
  });
});

/**
 * Keeps background maintenance at 10% duty on the writer: after a slice over 25 ms it sleeps nine
 * times as long. The caller's first slice starts when this is built.
 */
const makeDutyCycle = Effect.gen(function* () {
  let sliceStarted = yield* Clock.monotonicTimeNanos;
  return Effect.gen(function* () {
    const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
    if (elapsed < 25_000_000n) return;
    yield* Effect.sleep((Number(elapsed) / 1_000_000) * 9);
    sliceStarted = yield* Clock.monotonicTimeNanos;
  });
});

/**
 * Frees pages one statement at a time until `maxPages`, an empty freelist, or `proceed` says stop.
 * The writer runs on the server's main thread and a single freed page took up to 3.7 s on a large
 * database, so `proceed` is asked before every page: a write that lands mid-pass ends the pass.
 */
export const reclaimFreePages = Effect.fn("DatabaseStorage.reclaimFreePages")(function* (
  sql: SqlClient.SqlClient,
  maxPages: number,
  proceed: Effect.Effect<boolean, SqlError.SqlError>,
) {
  const paced = yield* makeDutyCycle;
  let freed = 0;
  while (freed < maxPages && (yield* proceed)) {
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    if ((free[0]?.freelist_count ?? 0) === 0) break;
    // The driver steps once per statement; incremental_vacuum frees one page per step.
    yield* sql`PRAGMA incremental_vacuum(1)`;
    freed++;
    yield* paced;
    yield* Effect.yieldNow;
  }
  return freed;
});

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    /** Return free pages to the filesystem on databases with incremental auto_vacuum. */
    readonly reclaim: Effect.Effect<void>;
    /** Current file accounting, re-published after each maintenance pass. Null until first read. */
    readonly status: Stream.Stream<DatabaseStorageStatus | null>;
  }
>()("t3/persistence/DatabaseStorage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statusRef = yield* SubscriptionRef.make<DatabaseStorageStatus | null>(null);

  // The notice shows host-shell quoting verbatim; desktop needs its launcher because t3 is absent from PATH.
  const { command: compactCommand } = yield* resolveHostCliCommand("doctor", [
    "--base-dir",
    config.baseDir,
  ]);
  // doctor --base-dir targets userdata, not implicit dev homes; suppress status to avoid touching the live install.
  const doctorTargetsThisDatabase =
    path.resolve(config.dbPath) ===
    path.resolve(config.baseDir, "userdata", path.basename(config.dbPath));
  // Only VACUUM changes these, and doctor refuses to VACUUM while a server has the database open.
  let layout: { readonly pageSize: number; readonly incrementalVacuum: boolean } | undefined;
  const readLayout = Effect.suspend(() =>
    layout !== undefined
      ? Effect.succeed(layout)
      : Effect.gen(function* () {
          const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
          const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
          layout = {
            pageSize: size[0]?.page_size ?? 0,
            incrementalVacuum: mode[0]?.auto_vacuum === 2,
          };
          return layout;
        }),
  );
  const publishStatus = Effect.gen(function* () {
    if (!doctorTargetsThisDatabase) return;
    const { pageSize, incrementalVacuum } = yield* readLayout;
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const next: DatabaseStorageStatus = {
      databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
      reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
      incrementalVacuumEnabled: incrementalVacuum,
      compactCommand,
    };
    // Every set reaches each open Storage page; most passes change nothing.
    if (!Equal.equals(yield* SubscriptionRef.get(statusRef), next)) {
      yield* SubscriptionRef.set(statusRef, next);
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database storage inspection failed", { cause })),
  );

  const reclaimPass = Effect.fn("DatabaseStorage.reclaimPass")(
    function* (proceed: Effect.Effect<boolean, SqlError.SqlError>) {
      if (!(yield* readLayout).incrementalVacuum) return;
      yield* reclaimFreePages(sql, RECLAIM_PAGES_PER_PASS, proceed);
    },
    Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
  );
  // Callers that ask for a reclaim want it now; only the background loop waits for a quiet writer.
  const reclaim = reclaimPass(Effect.succeed(true));
  const writerIdle = yield* makeWriterIdleGate(RECLAIM_WRITER_IDLE);

  // Even a pass that deletes nothing scans the event store. Persist completion
  // so restarting does not trigger another scan before the six-hour interval.
  const compactedAtPath = path.join(path.dirname(config.dbPath), "compacted-at");
  const compact = Effect.gen(function* () {
    const betweenPages = yield* makeDutyCycle;
    const result = yield* maintenance.pruneEventStore(betweenPages);
    const completedAt = yield* Clock.currentTimeMillis;
    yield* fs.writeFileString(compactedAtPath, String(completedAt)).pipe(Effect.ignore);
    if (result.deletedEventCount > 0 || result.deletedReceiptCount > 0) {
      yield* Effect.logInfo("Compacted orchestration history", result);
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Orchestration history compaction failed", { cause }),
    ),
  );
  const lastCompactedAt = yield* fs.readFileString(compactedAtPath).pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => Number.NaN),
  );
  const intervalMs = Duration.toMillis(COMPACTION_INTERVAL);
  const untilDueMs = Number.isFinite(lastCompactedAt)
    ? lastCompactedAt + intervalMs - (yield* Clock.currentTimeMillis)
    : 0;
  const firstCompactionDelay = Duration.millis(
    Math.min(intervalMs, Math.max(Duration.toMillis(Duration.minutes(1)), untilDueMs)),
  );

  yield* forkParked(
    Effect.sleep(firstCompactionDelay).pipe(
      Effect.andThen(
        compact.pipe(
          Effect.andThen(publishStatus),
          Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)),
        ),
      ),
    ),
  );
  yield* forkParked(
    publishStatus.pipe(
      Effect.andThen(Effect.sleep(RECLAIM_INTERVAL)),
      Effect.andThen(
        reclaimPass(writerIdle).pipe(
          Effect.andThen(publishStatus),
          Effect.repeat(Schedule.spaced(RECLAIM_INTERVAL)),
        ),
      ),
    ),
  );

  return DatabaseStorage.of({ reclaim, status: SubscriptionRef.changes(statusRef) });
});

export const layer = Layer.effect(DatabaseStorage, make);
