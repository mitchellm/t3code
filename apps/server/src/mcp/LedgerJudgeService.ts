import { NodeId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as LedgerJudgeRunner from "../orchestration-v2/LedgerJudgeRunner.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Tries per live settle, the first included. */
export const SETTLE_ATTEMPTS = 5;

/**
 * Fork: the automatic ledger judge's two server-side halves. Starting is an outbox effect, so it
 * survives restarts; this binds the effect worker's runner to the orchestrator MCP service that
 * can delegate. Settling happens when the judge task ends: seen live from the event stream, and
 * by a startup scan for any that ended while the server was down. Both halves are idempotent.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const orchestratorMcp = yield* OrchestratorMcpService.OrchestratorMcpService;
  const runner = yield* LedgerJudgeRunner.LedgerJudgeRunner;
  const sql = yield* SqlClient.SqlClient;

  // A live terminal event is seen once, so a transient failure gets a few tries before it waits
  // for the next startup scan. Settling is idempotent, so a retry after a partial success is safe.
  const settle = (threadId: ThreadId, taskId: NodeId) =>
    orchestratorMcp.settleLedgerJudgement({ threadId, taskId }).pipe(
      Effect.retry({ times: SETTLE_ATTEMPTS - 1, schedule: Schedule.exponential("200 millis") }),
      Effect.catchCause((cause) =>
        Effect.logWarning("ledger judge settle failed", { threadId, taskId, cause }),
      ),
    );

  const scanJudging = Effect.fn("LedgerJudgeService.scanJudging")(function* () {
    // A judging item without a task still has its start effect in the outbox, so only items
    // whose judge was started can have ended unseen.
    const rows = yield* sql<{ readonly thread_id: string; readonly task_id: string }>`
      SELECT ledger.thread_id AS thread_id, json_extract(item.value, '$.judgeTaskId') AS task_id
      FROM orchestration_v2_projection_ledgers AS ledger,
        json_each(ledger.payload_json, '$.items') AS item
      WHERE ledger.open_item_count > 0
        AND json_extract(item.value, '$.judging') = 1
        AND json_extract(item.value, '$.judgeTaskId') IS NOT NULL
    `;
    for (const row of rows) {
      yield* settle(ThreadId.make(row.thread_id), NodeId.make(row.task_id));
    }
  });

  const start = Effect.fn("LedgerJudgeService.start")(function* () {
    yield* runner.bind({
      start: (input) =>
        orchestratorMcp
          .startLedgerJudgement(input)
          .pipe(
            Effect.mapError(
              (cause) =>
                new LedgerJudgeRunner.LedgerJudgeRunnerError({ detail: cause.message, cause }),
            ),
          ),
    });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "subagent.updated" &&
        event.payload.origin === "app_owned" &&
        event.payload.role === "judge" &&
        TERMINAL.has(event.payload.status)
          ? settle(event.payload.threadId, event.payload.id)
          : Effect.void,
      ),
    );
    // Forked after the live listener, so a judge that ends while the scan runs is seen by one of
    // them; settling twice is harmless.
    yield* forkParked(
      scanJudging().pipe(
        Effect.catchCause((cause) => Effect.logWarning("ledger judge scan failed", { cause })),
      ),
    );
  });
  return { start, settle, scanJudging };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((service) => service.start())));
