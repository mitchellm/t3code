import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { makeClaudeSessionWaits } from "./ClaudeSessionWaits.ts";

const frame = (fields: Record<string, unknown>) =>
  ({ type: "system", uuid: "u", session_id: "s", ...fields }) as unknown as SDKMessage;

const level = (tasks: ReadonlyArray<Record<string, unknown>>) =>
  frame({ subtype: "background_tasks_changed", tasks });

describe("ambient tasks", () => {
  it("takes the flag from each level, which replaces the last one", () => {
    const waits = makeClaudeSessionWaits();
    waits.observeTaskFrame(
      "native",
      level([
        { task_id: "dream", task_type: "dream", description: "Memory", ambient: true },
        { task_id: "build", task_type: "local_bash", description: "Build" },
      ]),
    );
    expect(waits.isAmbient("native", "dream")).toBe(true);
    expect(waits.isAmbient("native", "build")).toBe(false);
    // Another session's tasks are its own.
    expect(waits.isAmbient("other", "dream")).toBe(false);

    waits.observeTaskFrame("native", level([{ task_id: "build", task_type: "local_bash" }]));
    expect(waits.isAmbient("native", "dream")).toBe(false);
  });

  it("adds a flagged task_started and drops it when its notification ends it", () => {
    const waits = makeClaudeSessionWaits();
    waits.observeTaskFrame(
      "native",
      frame({ subtype: "task_started", task_id: "w", ambient: true }),
    );
    waits.observeTaskFrame("native", frame({ subtype: "task_started", task_id: "b" }));
    expect(waits.isAmbient("native", "w")).toBe(true);
    expect(waits.isAmbient("native", "b")).toBe(false);
    waits.observeTaskFrame("native", frame({ subtype: "task_notification", task_id: "w" }));
    expect(waits.isAmbient("native", "w")).toBe(false);
  });
});

describe("session crons", () => {
  const cron = { id: "c1", schedule: "30 14 27 10 *", recurring: false, prompt: "Check the build" };

  it("lists what the last stop reported as background work, until a stop reports none", () => {
    const waits = makeClaudeSessionWaits();
    waits.recordCrons("native", [cron, { ...cron, id: "loop", recurring: true }]);
    expect(waits.cronTasks("native")).toEqual([
      {
        taskId: "cron:c1",
        kind: "background_task",
        description: "Scheduled wakeup: Check the build",
      },
      {
        taskId: "cron:loop",
        kind: "background_task",
        description: "Recurring wakeup: Check the build",
      },
    ]);
    expect(waits.cronTasks("other")).toEqual([]);
    expect(waits.cronTasks(null)).toEqual([]);

    // A fired one-shot or a deleted cron is gone from the next stop's list.
    waits.recordCrons("native", [{ ...cron, id: "loop", recurring: true }]);
    expect(waits.cronTasks("native").map(({ taskId }) => taskId)).toEqual(["cron:loop"]);
    waits.recordCrons("native", []);
    expect(waits.cronTasks("native")).toEqual([]);
  });

  it("forgets crons and ambient tasks when the session's CLI process is replaced", () => {
    const waits = makeClaudeSessionWaits();
    waits.recordCrons("native", [cron]);
    waits.observeTaskFrame("native", level([{ task_id: "dream", ambient: true }]));
    waits.clear("native");
    expect(waits.cronTasks("native")).toEqual([]);
    expect(waits.isAmbient("native", "dream")).toBe(false);
  });
});
