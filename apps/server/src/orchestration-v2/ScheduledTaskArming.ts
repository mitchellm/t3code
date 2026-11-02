import type { ScheduledTaskId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";

/**
 * Whether a scheduled task will fire again on its own. The scheduler lives in the database and a
 * restart already re-queues a run it cut, so a thread whose only lost work was one tick needs no
 * model turn to carry on. The default says no, which keeps the recovery turn for runtimes built
 * without the scheduler.
 */
export class ScheduledTaskArming extends Context.Reference<{
  readonly isArmed: (taskId: ScheduledTaskId) => Effect.Effect<boolean>;
}>("t3/orchestration-v2/ScheduledTaskArming", {
  defaultValue: () => ({ isArmed: () => Effect.succeed(false) }),
}) {}

export const layer = Layer.effect(
  ScheduledTaskArming,
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    return {
      isArmed: Effect.fn("ScheduledTaskArming.isArmed")(
        function* (taskId: ScheduledTaskId) {
          const { tasks } = yield* scheduledTasks.list();
          return tasks.some(
            (task) => task.id === taskId && task.enabled && task.nextRunAt !== null,
          );
        },
        Effect.orElseSucceed(() => false),
      ),
    };
  }),
);
