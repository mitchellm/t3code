/**
 * Fork: what tells a Claude session that is waiting from one that is done, kept per native thread
 * for the Stop hook. Its own input lists in-flight tasks without the CLI's ambient flag, which only
 * the task frames carry, and its crons reach the between-turn follow-up only through the roster.
 * Memory only: a new CLI process starts with neither.
 */
import type { SDKMessage, SessionCronSummary } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export interface ClaudeSessionWaits {
  readonly observeTaskFrame: (nativeThreadId: string, message: SDKMessage) => void;
  readonly isAmbient: (nativeThreadId: string, taskId: string) => boolean;
  /** What the latest stop reported; it replaces the last report, so a fired or deleted cron goes. */
  readonly recordCrons: (nativeThreadId: string, crons: ReadonlyArray<SessionCronSummary>) => void;
  readonly cronTasks: (
    nativeThreadId: string | null,
  ) => ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly clear: (nativeThreadId: string) => void;
}

const stringField = (value: unknown, key: string) => {
  const field = Predicate.isObject(value) ? Reflect.get(value, key) : undefined;
  return typeof field === "string" ? field : undefined;
};

const isAmbientEntry = (value: unknown) =>
  Predicate.isObject(value) && Reflect.get(value, "ambient") === true;

// A cron is a wait whatever T3 was told, so its kind is one that holds the thread as waiting.
const cronTask = (cron: SessionCronSummary): OrchestrationV2PendingBackgroundTask => ({
  taskId: `cron:${cron.id}`,
  kind: "background_task",
  description: `${cron.recurring ? "Recurring" : "Scheduled"} wakeup: ${cron.prompt}`,
});

export function makeClaudeSessionWaits(): ClaudeSessionWaits {
  const ambientByThread = new Map<string, Set<string>>();
  const cronsByThread = new Map<string, ReadonlyArray<OrchestrationV2PendingBackgroundTask>>();
  const ambientOf = (nativeThreadId: string) => {
    const existing = ambientByThread.get(nativeThreadId);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    ambientByThread.set(nativeThreadId, created);
    return created;
  };
  return {
    observeTaskFrame: (nativeThreadId, message) => {
      if (message.type !== "system") return;
      const subtype = stringField(message, "subtype");
      if (subtype === "background_tasks_changed") {
        // A level lists every live task, so it replaces the set rather than adding to it.
        const tasks = Reflect.get(message, "tasks");
        if (!Array.isArray(tasks)) return;
        const ambient = tasks.flatMap((task) => {
          const taskId = stringField(task, "task_id");
          return taskId !== undefined && isAmbientEntry(task) ? [taskId] : [];
        });
        if (ambient.length === 0) ambientByThread.delete(nativeThreadId);
        else ambientByThread.set(nativeThreadId, new Set(ambient));
        return;
      }
      const taskId = stringField(message, "task_id");
      if (taskId === undefined) return;
      if (subtype === "task_started" && isAmbientEntry(message))
        ambientOf(nativeThreadId).add(taskId);
      if (subtype === "task_notification") ambientByThread.get(nativeThreadId)?.delete(taskId);
    },
    isAmbient: (nativeThreadId, taskId) =>
      ambientByThread.get(nativeThreadId)?.has(taskId) === true,
    recordCrons: (nativeThreadId, crons) => {
      if (crons.length === 0) cronsByThread.delete(nativeThreadId);
      else cronsByThread.set(nativeThreadId, crons.map(cronTask));
    },
    cronTasks: (nativeThreadId) =>
      nativeThreadId === null ? [] : (cronsByThread.get(nativeThreadId) ?? []),
    clear: (nativeThreadId) => {
      ambientByThread.delete(nativeThreadId);
      cronsByThread.delete(nativeThreadId);
    },
  };
}
