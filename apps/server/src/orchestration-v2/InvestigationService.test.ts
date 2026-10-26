import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type Ledger,
  LedgerItemId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { applyLedgerEvent } from "@t3tools/shared/taskLedger";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import type { ModelRate, RateTable } from "../usage/usagePricing.ts";
import { investigationEffects } from "./Investigation.ts";
import {
  awaitInvestigationDeadline,
  checkInvestigationBudget,
  criteriaPinText,
  type InvestigationDeps,
  requestInvestigationReport,
  startInvestigation,
  stopInvestigation,
} from "./InvestigationService.ts";
import { ledgerEventFromPlan, type LedgerCommand, planLedgerCommand } from "./TaskLedger.ts";

const threadId = ThreadId.make("thread:investigate");

/** The usage records of a thread the fake serves; only the fields the spend walk reads. */
interface FakeThreadUsage {
  readonly providerTurns: ReadonlyArray<unknown>;
  readonly runs: ReadonlyArray<unknown>;
  readonly subagents: ReadonlyArray<unknown>;
}

/**
 * An orchestrator that keeps one ledger and runs ledger commands through the real planner, so the
 * service is tested against the same transitions the server commits.
 */
function fakeOrchestrator(
  options: {
    readonly usage?: Readonly<Record<string, FakeThreadUsage>>;
    readonly rates?: RateTable;
  } = {},
) {
  let ledger: Ledger | undefined;
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const stopEffects: Array<string> = [];
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      dispatched.push(command);
      if (command.type.startsWith("ledger.")) {
        const ledgerCommand = command as LedgerCommand;
        const now = yield* DateTime.now;
        const planned = planLedgerCommand({
          command: ledgerCommand,
          ledger,
          now,
          requiresJudge: true,
        });
        if (Result.isFailure(planned)) return yield* Effect.die(planned.failure);
        for (const event of planned.success) {
          ledger = applyLedgerEvent(ledger, {
            ...ledgerEventFromPlan(event, {
              threadId,
              providerInstanceId: ProviderInstanceId.make("planner"),
              occurredAt: now,
            }),
            id: EventId.make(`event:${dispatched.length}`),
          });
        }
        for (const effect of investigationEffects(ledgerCommand, planned.success)) {
          stopEffects.push(effect.request.type);
        }
      }
      return { sequence: dispatched.length, storedEvents: [] };
    });
  const getThreadRecords = (id: ThreadId) =>
    Effect.sync(() => ({
      ledger: id === threadId ? ledger : undefined,
      subagents: [],
      providerTurns: [],
      runs: [],
      ...options.usage?.[id],
      messages: dispatched.flatMap((command) =>
        command.type === "message.dispatch" ? [{ id: command.messageId }] : [],
      ),
    }));
  const deps = {
    // The fake answers every field the service reads; the generic signature cannot be matched.
    orchestrator: { dispatch, getThreadRecords } as unknown as InvestigationDeps["orchestrator"],
    rateTable: Effect.succeed(options.rates ?? new Map()),
  } satisfies InvestigationDeps;
  return { deps, dispatched, stopEffects, ledger: () => ledger };
}

const startInput = {
  threadId,
  requestId: "req-1",
  goal: "Find why the sync job drops rows",
  solvedWhen: "A failing test reproduces the drop and passes with the fix.",
  budget: { minutes: 30 },
  parallelApproaches: 2,
} as const;

const addApproaches = (fake: ReturnType<typeof fakeOrchestrator>) =>
  fake.deps.orchestrator.dispatch({
    type: "ledger.item.add",
    commandId: CommandId.make("command:add"),
    threadId,
    ledgerId: fake.ledger()!.id,
    items: ["a", "b"].map((name) => ({
      id: LedgerItemId.make(name),
      title: `Approach ${name}`,
      acceptance: "thesis",
      parentItemId: LedgerItemId.make("approaches"),
    })),
  });

describe("InvestigationService", () => {
  it.effect("start creates the investigation, pins the criteria verbatim and sends the goal", () =>
    Effect.gen(function* () {
      const fake = fakeOrchestrator();
      yield* startInvestigation(fake.deps, startInput);
      assert.strictEqual(fake.ledger()?.investigation?.status, "running");
      const pin = fake.dispatched.find((command) => command.type === "thread.rule-pin.add");
      assert.strictEqual(
        pin?.type === "thread.rule-pin.add" ? pin.text : undefined,
        criteriaPinText(startInput.solvedWhen),
      );
      assert.include(criteriaPinText(startInput.solvedWhen), startInput.solvedWhen);
      const kickoff = fake.dispatched.find((command) => command.type === "message.dispatch");
      assert.isTrue(
        kickoff?.type === "message.dispatch" && kickoff.text.startsWith(startInput.goal),
      );
      // A retried start replays the same keyed commands.
      const before = fake.dispatched.map((command) => command.commandId);
      yield* startInvestigation(fake.deps, startInput);
      assert.deepStrictEqual(
        fake.dispatched.slice(before.length).map((command) => command.commandId),
        before,
      );
    }),
  );

  it.effect(
    "the deadline ends it exhausted, stops every child and asks for a best-so-far report",
    () =>
      Effect.gen(function* () {
        const fake = fakeOrchestrator();
        yield* startInvestigation(fake.deps, startInput);
        yield* addApproaches(fake);
        const investigation = fake.ledger()!.investigation!;
        const timer = yield* Effect.forkChild(
          awaitInvestigationDeadline(fake.deps, threadId, investigation),
        );
        yield* TestClock.adjust("29 minutes");
        yield* checkInvestigationBudget(fake.deps, threadId);
        assert.strictEqual(fake.ledger()?.investigation?.status, "running");
        yield* TestClock.adjust("1 minute");
        yield* Fiber.join(timer);
        const ended = fake.ledger()!;
        assert.strictEqual(ended.investigation?.status, "exhausted");
        assert.isTrue(
          ended.items.every((item) => item.status === "dropped"),
          "every approach and the Approaches item are dropped",
        );
        assert.deepStrictEqual(fake.stopEffects, ["delegated-tasks.stop"]);
        yield* requestInvestigationReport(fake.deps, threadId, ended.id, ended.investigation!);
        yield* requestInvestigationReport(fake.deps, threadId, ended.id, ended.investigation!);
        const reports = fake.dispatched.filter(
          (command) => command.type === "message.dispatch" && command.text.includes("best-so-far"),
        );
        assert.strictEqual(reports.length, 1);
      }),
  );

  it.effect("Stop all ends it stopped, stops every child and asks for no report", () =>
    Effect.gen(function* () {
      const fake = fakeOrchestrator();
      yield* startInvestigation(fake.deps, startInput);
      yield* addApproaches(fake);
      yield* stopInvestigation(fake.deps, threadId);
      const ended = fake.ledger()!;
      assert.strictEqual(ended.investigation?.status, "stopped");
      assert.deepStrictEqual(fake.stopEffects, ["delegated-tasks.stop"]);
      // The planner's own turn stops too, as a user's Stop (no agent reason).
      const plannerStop = fake.dispatched.find((command) => command.type === "thread.stop");
      assert.isTrue(
        plannerStop?.type === "thread.stop" &&
          plannerStop.threadId === threadId &&
          plannerStop.reason === undefined,
      );
      const sent = fake.dispatched.length;
      yield* requestInvestigationReport(fake.deps, threadId, ended.id, ended.investigation!);
      assert.strictEqual(fake.dispatched.length, sent);
      const again = yield* Effect.result(stopInvestigation(fake.deps, threadId));
      assert.isTrue(Result.isFailure(again));
    }),
  );

  const dollarsOnly = { ...startInput, budget: { usd: 0.5 } } as const;
  const turn = (node: string, outputTokens: number) => ({
    nodeId: node,
    startedAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
    turnTokenUsage: { inputTokens: 0, outputTokens },
  });
  const run = (node: string) => ({ rootNodeId: node, modelSelection: { model: "priced-model" } });
  const rate: ModelRate = {
    inputCostPerToken: 0,
    outputCostPerToken: 0.001,
    cacheReadCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    fast: null,
    ultrafast: null,
  };

  it.effect("records spend on the record, counting tasks under tasks, and ends on dollars", () =>
    Effect.gen(function* () {
      const child = ThreadId.make("thread:child");
      const grandchild = ThreadId.make("thread:grandchild");
      const task = (childThreadId: ThreadId) => ({ origin: "app_owned", childThreadId });
      const fake = fakeOrchestrator({
        rates: new Map([["priced-model", rate]]),
        usage: {
          [threadId]: {
            providerTurns: [turn("n0", 100)],
            runs: [run("n0")],
            subagents: [task(child)],
          },
          [child]: {
            providerTurns: [turn("n1", 300)],
            runs: [run("n1")],
            subagents: [task(grandchild)],
          },
          [grandchild]: { providerTurns: [turn("n2", 400)], runs: [run("n2")], subagents: [] },
        },
      });
      yield* startInvestigation(fake.deps, dollarsOnly);
      yield* checkInvestigationBudget(fake.deps, threadId);
      // 100 + 300 + 400 output tokens at $0.001: the grandchild's $0.40 is what tips it over.
      const ended = fake.ledger()!.investigation!;
      assert.strictEqual(ended.status, "exhausted");
      const spend = fake.dispatched.find(
        (command) => command.type === "ledger.investigation.spend",
      );
      assert.isTrue(spend?.type === "ledger.investigation.spend" && spend.spentUsd > 0.79);
    }),
  );

  it.effect("without rates, a dollars-only budget says its cost is unknown instead of ending", () =>
    Effect.gen(function* () {
      const fake = fakeOrchestrator({
        usage: {
          [threadId]: { providerTurns: [turn("n0", 5_000)], runs: [run("n0")], subagents: [] },
        },
      });
      yield* startInvestigation(fake.deps, dollarsOnly);
      yield* checkInvestigationBudget(fake.deps, threadId);
      const investigation = fake.ledger()!.investigation!;
      assert.strictEqual(investigation.status, "running");
      assert.strictEqual(investigation.costUnknown, true);
      assert.strictEqual(investigation.spentUsd, 0);
    }),
  );
});
