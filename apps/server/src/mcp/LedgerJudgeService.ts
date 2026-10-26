import { type NodeId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as LedgerJudgeRunner from "../orchestration-v2/LedgerJudgeRunner.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

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

  const settle = (threadId: ThreadId, taskId: NodeId) =>
    orchestratorMcp
      .settleLedgerJudgement({ threadId, taskId })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("ledger judge settle failed", { threadId, taskId, cause }),
        ),
      );

  // Rows are one per thread; the JSON filter only narrows which ledgers to read.
  const scanJudging = Effect.fn("LedgerJudgeService.scanJudging")(function* () {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_ledgers
      WHERE open_item_count > 0 AND payload_json LIKE '%"judging":true%'
    `;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      const { ledger } = yield* orchestrator.getThreadRecords(threadId, ["ledger"]);
      for (const item of ledger?.items ?? []) {
        // A judging item without a task still has its start effect in the outbox.
        if (item.judging === true && item.judgeTaskId !== undefined) {
          yield* settle(threadId, item.judgeTaskId);
        }
      }
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
  return { start, scanJudging };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((service) => service.start())));
