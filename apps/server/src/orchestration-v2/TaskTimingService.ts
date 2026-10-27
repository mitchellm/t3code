import {
  type TaskStats,
  type TaskTiming,
  type TaskTimingSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { deriveTaskStats, TASK_STATS_TOOL_ITEM_TYPES } from "./TaskStats.ts";
import { deriveTaskTiming, summarizeTaskTiming } from "./TaskTiming.ts";

export class TaskTimingReadError extends Schema.TaggedError<TaskTimingReadError>()(
  "TaskTimingReadError",
  {
    threadId: ThreadId,
    source: Schema.Literals(["projection", "events"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.source} for the task timing of thread ${this.threadId}.`;
  }
}

/**
 * Per-step timing of one thread, computed on read from the projection and the thread's ledger
 * events. Nothing here is stored: the event log already timestamps every step.
 */
export class TaskTimingService extends Context.Service<
  TaskTimingService,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<TaskTiming, TaskTimingReadError>;
    /** The record cut to its slowest steps, for agents and the Timing view. */
    readonly summary: (threadId: ThreadId) => Effect.Effect<TaskTimingSummary, TaskTimingReadError>;
    /** Fork: tokens, tool calls and current activity of a delegated task's own thread. */
    readonly taskStats: (threadId: ThreadId) => Effect.Effect<TaskStats, TaskTimingReadError>;
  }
>()("t3/orchestration-v2/TaskTimingService") {}

const CHILD_READ_CONCURRENCY = 4;
const SUMMARY_TOP = 5;

/** @public */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventStore.EventStoreV2;
  const sql = yield* SqlClient.SqlClient;

  const forThread: TaskTimingService["Service"]["forThread"] = Effect.fn(
    "TaskTimingService.forThread",
  )(function* (threadId) {
    const now = yield* DateTime.now;
    const readError = Effect.mapError(
      (cause: ProjectionStore.ProjectionStoreV2Error) =>
        new TaskTimingReadError({ threadId, source: "projection", cause }),
    );
    const records = yield* projections
      .getThreadRecords(threadId, ["runs", "subagents", "runtimeRequests", "ledger"])
      .pipe(readError);
    // Only the source of each user message is needed, so the messages themselves stay unread.
    const userMessages = yield* projections.getUserMessageCreationSources(threadId).pipe(readError);

    const delegated = yield* Effect.forEach(
      records.subagents.filter((task) => task.origin === "app_owned"),
      (task) =>
        task.childThreadId === null
          ? Effect.succeed({ task, childRun: undefined })
          : projections.getThreadRecords(task.childThreadId, ["runs"]).pipe(
              Effect.map(({ runs }) => ({
                task,
                // A follow-up in the same child thread is a later run, not this task's.
                childRun:
                  runs.find((run) => run.delegatedTaskId === task.id) ??
                  runs.toSorted((left, right) => left.ordinal - right.ordinal)[0],
              })),
              // A deleted child thread only costs the wait time, not the whole record.
              Effect.orElseSucceed(() => ({ task, childRun: undefined })),
            ),
      { concurrency: CHILD_READ_CONCURRENCY },
    );

    // Item changes are the one thing the projection does not keep, so the event log is read for
    // them, and only for a thread that has a ledger.
    const itemUpdates =
      records.ledger === undefined
        ? []
        : (yield* events.read({ threadId, eventType: "ledger.item.updated" }).pipe(
            Stream.runCollect,
            Effect.mapError(
              (cause) => new TaskTimingReadError({ threadId, source: "events", cause }),
            ),
          )).flatMap(({ event }) =>
            event.type === "ledger.item.updated"
              ? [
                  {
                    at: event.occurredAt,
                    ledgerId: event.payload.ledgerId,
                    item: event.payload.item,
                  },
                ]
              : [],
          );

    return deriveTaskTiming({
      threadId,
      now,
      runs: records.runs,
      userMessages,
      delegated,
      runtimeRequests: records.runtimeRequests,
      ledger: records.ledger,
      itemUpdates,
    });
  });

  const summary: TaskTimingService["Service"]["summary"] = Effect.fn("TaskTimingService.summary")(
    function* (threadId) {
      return summarizeTaskTiming(yield* forThread(threadId), SUMMARY_TOP);
    },
  );

  const taskStats: TaskTimingService["Service"]["taskStats"] = Effect.fn(
    "TaskTimingService.taskStats",
  )(function* (threadId) {
    const readError = Effect.mapError(
      (cause: unknown) => new TaskTimingReadError({ threadId, source: "projection", cause }),
    );
    const records = yield* projections
      .getThreadRecords(threadId, ["providerTurns", "providerThreads"])
      .pipe(readError);
    // Tool payloads run to megabytes on a long thread, so they are counted and the one live row
    // is picked in SQL instead of being read and parsed.
    const [counted, live] = yield* Effect.all([
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND type IN ${sql.in(TASK_STATS_TOOL_ITEM_TYPES)}
      `,
      sql<{
        readonly type: string;
        readonly title: string | null;
        readonly tool_name: string | null;
        readonly detail: string | null;
      }>`
        SELECT type,
          json_extract(payload_json, '$.title') AS title,
          json_extract(payload_json, '$.toolName') AS tool_name,
          substr(COALESCE(
            CASE WHEN type = 'command_execution' THEN json_extract(payload_json, '$.input') END,
            json_extract(payload_json, '$.fileName'),
            json_extract(payload_json, '$.pattern'),
            json_extract(payload_json, '$.patterns[0]'),
            json_extract(payload_json, '$.input.command'),
            json_extract(payload_json, '$.input.description'),
            json_extract(payload_json, '$.input.file_path'),
            json_extract(payload_json, '$.input.path'),
            json_extract(payload_json, '$.input.pattern'),
            json_extract(payload_json, '$.input.query'),
            json_extract(payload_json, '$.input.url')
          ), 1, 400) AS detail
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId}
          AND type IN ${sql.in(TASK_STATS_TOOL_ITEM_TYPES)}
          AND status IN ('pending', 'running', 'waiting')
        ORDER BY ordinal DESC
        LIMIT 1
      `,
    ]).pipe(NodeSqliteClient.readOnly, readError);
    const row = live[0];
    return deriveTaskStats({
      thread: records.thread,
      providerTurns: records.providerTurns,
      providerThreads: records.providerThreads,
      toolCalls: counted[0]?.count ?? 0,
      liveTool:
        row === undefined
          ? null
          : { type: row.type, title: row.title, toolName: row.tool_name, detail: row.detail },
    });
  });

  return TaskTimingService.of({ forThread, summary, taskStats });
});

export const layer = Layer.effect(TaskTimingService, make);
