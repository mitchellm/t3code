import { assert, it } from "@effect/vitest";
import { ScheduledTaskError, ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ScheduledTaskArming from "./ScheduledTaskArming.ts";

const task = (id: string, extra: { enabled?: boolean; nextRunAt?: string | null }) => ({
  id: ScheduledTaskId.make(id),
  enabled: extra.enabled ?? true,
  nextRunAt: extra.nextRunAt === undefined ? "2026-11-02T12:00:00.000Z" : extra.nextRunAt,
});

const isArmed = (
  listing: Effect.Effect<{ readonly tasks: ReadonlyArray<unknown> }, ScheduledTaskError>,
) =>
  Effect.gen(function* () {
    const arming = yield* ScheduledTaskArming.ScheduledTaskArming;
    return (id: string) => arming.isArmed(ScheduledTaskId.make(id));
  }).pipe(
    Effect.provide(
      ScheduledTaskArming.layer.pipe(
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () => listing as never,
          }),
        ),
      ),
    ),
  );

it.effect("counts a task as armed only while it is enabled and has a next run", () =>
  Effect.gen(function* () {
    const check = yield* isArmed(
      Effect.succeed({
        tasks: [
          task("armed", {}),
          task("disabled", { enabled: false }),
          task("finished", { nextRunAt: null }),
        ],
      }),
    );
    assert.isTrue(yield* check("armed"));
    assert.isFalse(yield* check("disabled"));
    assert.isFalse(yield* check("finished"));
    assert.isFalse(yield* check("deleted"));
  }),
);

it.effect("treats an unreadable task list as not armed so the thread still gets its turn", () =>
  Effect.gen(function* () {
    const check = yield* isArmed(Effect.fail(new ScheduledTaskError({ message: "db busy" })));
    assert.isFalse(yield* check("armed"));
  }),
);
