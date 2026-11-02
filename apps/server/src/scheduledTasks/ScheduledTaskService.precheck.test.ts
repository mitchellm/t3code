import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTask, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  interpretPrecheck,
  PRECHECK_STDOUT_LIMIT_BYTES,
  ScheduledTaskPrecheckRunner,
  type PrecheckRaw,
  type PrecheckRequest,
} from "./precheck.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const encodeTask = Schema.encodeEffect(ScheduledTask);

const baseInput = {
  commandId: "precheck-task",
  title: "Tick",
  prompt: "Check for news.",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project-precheck",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

const SMALL_MODEL = { instanceId: "claudeAgent", model: "claude-haiku-5-5" } as const;

/** Layers around the service, recording every precheck, launch and bound send. */
function harness(raw: PrecheckRaw) {
  const prechecks: PrecheckRequest[] = [];
  const launches: Array<{
    readonly modelSelection: unknown;
    readonly initialMessage?: { readonly text: string } | undefined;
  }> = [];
  const sends: Array<{ readonly modelSelection?: unknown; readonly text: string }> = [];
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    ManagedPolicy.layerTest(),
    Layer.succeed(ScheduledTaskPrecheckRunner, (request: PrecheckRequest) =>
      Effect.sync(() => {
        prechecks.push(request);
        return raw;
      }),
    ),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (launch) =>
        Effect.sync(() => {
          launches.push(launch);
          return { threadId: "thread-launched" } as never;
        }),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      sendToThread: (send) =>
        Effect.sync(() => {
          sends.push(send);
          return {} as never;
        }),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
  );
  const layer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
  const run = <A, E>(
    effect: Effect.Effect<A, E, ScheduledTaskService.ScheduledTaskService | SqlClient.SqlClient>,
  ) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.provideService(ServerActivation, Effect.never),
      Effect.provide(SqlitePersistence.layerMemory),
    );
  return { prechecks, launches, sends, run };
}

const exited = (stdout: string, code = 0, stderr = ""): PrecheckRaw => ({
  _tag: "exited",
  code,
  stdout,
  stderr,
});

it.effect("a quiet precheck starts no turn and records a quiet run", () => {
  const { prechecks, launches, run } = harness(exited("  \n"));
  return run(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-02T10:00:00.000Z"));
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeInput({ ...baseInput, precheck: { command: "git status --short" } }),
      );
      const result = yield* service.runNow({ id: created.task.id });
      expect(launches).toHaveLength(0);
      expect(prechecks).toHaveLength(1);
      expect(result.threadId).toBeNull();
      expect(result.task.lastRunStatus).toBe("succeeded");
      expect(result.task.lastRunQuiet).toBe(true);
      expect(result.task.quietRunCount).toBe(1);
      expect(result.task.runCount).toBe(1);
      const stored = (yield* service.list()).tasks[0];
      expect(stored?.lastRunQuiet).toBe(true);
      expect(stored?.quietRunCount).toBe(1);
      expect(stored?.lastRunError).toBeNull();
    }),
  );
});

it.effect("a precheck with output starts the turn with that output in the prompt", () => {
  const { launches, run } = harness(exited("3 new messages from alice\n"));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeInput({ ...baseInput, precheck: { command: "node count.mjs" } }),
      );
      const result = yield* service.runNow({ id: created.task.id });
      expect(launches).toHaveLength(1);
      const text = launches[0]?.initialMessage?.text ?? "";
      expect(text.startsWith("Check for news.")).toBe(true);
      expect(text).toContain("## Precheck output");
      expect(text).toContain("3 new messages from alice");
      expect(result.threadId).toBe("thread-launched");
      expect(result.task.lastRunQuiet).toBeUndefined();
      expect(result.task.quietRunCount).toBeUndefined();
    }),
  );
});

it.effect.each([
  {
    name: "a failing exit",
    raw: exited("partial", 2, "boom: no token"),
    expected: "boom: no token",
  },
  {
    name: "a timeout",
    raw: { _tag: "timedOut", timeoutMs: 5_000 } as const,
    expected: "timed out after 5s",
  },
  {
    name: "a spawn error",
    raw: { _tag: "failed", message: "spawn ENOENT" } as const,
    expected: "spawn ENOENT",
  },
])("$name starts the turn with the error in the prompt", ({ raw, expected }) => {
  const { launches, run } = harness(raw);
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeInput({ ...baseInput, precheck: { command: "broken.sh" } }),
      );
      const result = yield* service.runNow({ id: created.task.id });
      expect(launches).toHaveLength(1);
      const text = launches[0]?.initialMessage?.text ?? "";
      expect(text).toContain("## Precheck failed");
      expect(text).toContain("broken.sh");
      expect(text).toContain(expected);
      expect(result.task.lastRunStatus).toBe("succeeded");
      expect(result.task.lastRunQuiet).toBeUndefined();
    }),
  );
});

it.effect("runs the precheck with the default timeout and the stored one", () => {
  const { prechecks, run } = harness(exited("news"));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const plain = yield* service.upsert(
        yield* decodeInput({ ...baseInput, precheck: { command: "a" } }),
      );
      yield* service.runNow({ id: plain.task.id });
      const custom = yield* service.upsert(
        yield* decodeInput({
          ...baseInput,
          commandId: "precheck-custom",
          precheck: { command: "b", timeoutMs: 30_000 },
        }),
      );
      yield* service.runNow({ id: custom.task.id });
      expect(prechecks.map((request) => request.timeoutMs)).toEqual([120_000, 30_000]);
      expect(prechecks[0]?.projectId).toBe("project-precheck");
      expect(prechecks[0]?.threadId).toBeNull();
    }),
  );
});

it.effect("a task without a precheck runs as before", () => {
  const { prechecks, launches, run } = harness(exited(""));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(yield* decodeInput(baseInput));
      yield* service.runNow({ id: created.task.id });
      expect(prechecks).toHaveLength(0);
      expect(launches[0]?.initialMessage?.text).toBe("Check for news.");
    }),
  );
});

it.effect("the model override starts a fresh thread's turn, else the stored selection", () => {
  const { launches, run } = harness(exited("news"));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const withOverride = yield* service.upsert(
        yield* decodeInput({ ...baseInput, modelOverride: SMALL_MODEL }),
      );
      yield* service.runNow({ id: withOverride.task.id });
      const without = yield* service.upsert(
        yield* decodeInput({ ...baseInput, commandId: "precheck-plain" }),
      );
      yield* service.runNow({ id: without.task.id });
      expect(launches[0]?.modelSelection).toEqual(SMALL_MODEL);
      expect(launches[1]?.modelSelection).toEqual(baseInput.modelSelection);
    }),
  );
});

it.effect("the model override is sent with a run bound to a thread, and absent otherwise", () => {
  const { sends, run } = harness(exited("news"));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const bound = yield* service.upsert(
        yield* decodeInput({
          ...baseInput,
          threadId: "thread-bound",
          modelOverride: SMALL_MODEL,
        }),
      );
      yield* service.runNow({ id: bound.task.id });
      const plain = yield* service.upsert(
        yield* decodeInput({
          ...baseInput,
          commandId: "precheck-bound-plain",
          threadId: "thread-bound",
        }),
      );
      yield* service.runNow({ id: plain.task.id });
      expect(sends[0]?.modelSelection).toEqual(SMALL_MODEL);
      expect(sends[1]).toBeDefined();
      expect("modelSelection" in (sends[1] ?? {})).toBe(false);
    }),
  );
});

it.effect("a bound run's precheck runs in the bound thread's checkout", () => {
  const { prechecks, run } = harness(exited("news"));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const bound = yield* service.upsert(
        yield* decodeInput({
          ...baseInput,
          threadId: "thread-bound",
          precheck: { command: "git fetch" },
        }),
      );
      yield* service.runNow({ id: bound.task.id });
      expect(prechecks[0]?.threadId).toBe("thread-bound");
    }),
  );
});

it.effect("saving without the new fields keeps them, and null clears them", () => {
  const { run } = harness(exited("news"));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeInput({
          ...baseInput,
          precheck: { command: "check.sh", timeoutMs: 45_000 },
          modelOverride: SMALL_MODEL,
        }),
      );
      expect(created.task.precheck).toEqual({ command: "check.sh", timeoutMs: 45_000 });
      expect(created.task.modelOverride).toEqual(SMALL_MODEL);
      // An older client's form: neither field present.
      const kept = yield* service.upsert(
        yield* decodeInput({ ...baseInput, id: created.task.id, title: "Renamed" }),
      );
      expect(kept.task.title).toBe("Renamed");
      expect(kept.task.precheck).toEqual({ command: "check.sh", timeoutMs: 45_000 });
      expect(kept.task.modelOverride).toEqual(SMALL_MODEL);
      const cleared = yield* service.upsert(
        yield* decodeInput({
          ...baseInput,
          id: created.task.id,
          precheck: null,
          modelOverride: null,
        }),
      );
      expect(cleared.task.precheck).toBeUndefined();
      expect(cleared.task.modelOverride).toBeUndefined();
      expect((yield* service.list()).tasks[0]?.precheck).toBeUndefined();
    }),
  );
});

it.effect("a task stored before the new columns decodes without them", () => {
  const { run } = harness(exited("news"));
  return run(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* service.upsert(yield* decodeInput(baseInput));
      yield* sql`UPDATE scheduled_tasks SET precheck_json = NULL, model_override_json = NULL, quiet_run_count = 0, last_run_quiet = 0`;
      const task = (yield* service.list()).tasks[0];
      expect(task?.id).toBe(created.task.id);
      expect(task?.precheck).toBeUndefined();
      expect(task?.modelOverride).toBeUndefined();
      expect(task?.quietRunCount).toBeUndefined();
    }),
  );
});

it.effect("contract tasks round-trip with and without the new fields", () =>
  Effect.gen(function* () {
    const common = {
      id: "task-1",
      title: "Tick",
      prompt: "Go",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId: "project-1",
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T10:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const old = yield* decodeTask(common);
    expect(old.precheck).toBeUndefined();
    expect(yield* encodeTask(old)).toEqual(common);
    const full = yield* decodeTask({
      ...common,
      precheck: { command: "echo hi", timeoutMs: 5_000 },
      modelOverride: SMALL_MODEL,
      lastRunQuiet: true,
      quietRunCount: 4,
    });
    expect(full.precheck).toEqual({ command: "echo hi", timeoutMs: 5_000 });
    expect((yield* encodeTask(full)).modelOverride).toEqual(SMALL_MODEL);
    expect(yield* Effect.flip(decodeTask({ ...common, precheck: { command: "" } }))).toBeDefined();
  }),
);

it("interpretPrecheck truncates large output and says so", () => {
  const verdict = interpretPrecheck("big.sh", exited("x".repeat(PRECHECK_STDOUT_LIMIT_BYTES * 2)));
  expect(verdict._tag).toBe("news");
  if (verdict._tag !== "news") return;
  expect(verdict.section).toContain(`truncated to the first ${PRECHECK_STDOUT_LIMIT_BYTES} bytes`);
  expect(verdict.section.length).toBeLessThan(PRECHECK_STDOUT_LIMIT_BYTES + 400);
});
