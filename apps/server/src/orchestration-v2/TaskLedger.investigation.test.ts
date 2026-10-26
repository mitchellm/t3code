import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type Ledger,
  LedgerId,
  LedgerItemId,
  type LedgerItemVerdict,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { investigationBudgetUse, investigationLanes } from "@t3tools/shared/investigation";
import { applyLedgerEvent } from "@t3tools/shared/taskLedger";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { APPROACHES_ITEM_ID, investigationEffects } from "./Investigation.ts";
import {
  type LedgerCommand,
  ledgerEventFromPlan,
  type PlannedLedgerEvent,
  planLedgerCommand,
} from "./TaskLedger.ts";

const start = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const threadId = ThreadId.make("thread:investigation");
const ledgerId = LedgerId.make("ledger:investigation");
const commandId = CommandId.make("command:investigation");
const id = (name: string) => LedgerItemId.make(name);
const at = (minutes: number) => DateTime.add(start, { minutes });

const verdict = (outcome: "pass" | "fail"): LedgerItemVerdict => ({
  outcome,
  judge: { instanceId: ProviderInstanceId.make("judge"), model: "judge-model" },
  notes: outcome === "pass" ? "Holds against the criteria." : "The repro still fails.",
  at: start,
});

/** Plans a command and folds its events in, as the projection would. */
function step(
  ledger: Ledger | undefined,
  command: LedgerCommand,
  now: DateTime.Utc,
  requiresJudge?: boolean,
): { readonly ledger: Ledger; readonly planned: ReadonlyArray<PlannedLedgerEvent> } {
  const planned = planLedgerCommand({
    command,
    ledger,
    now,
    ...(requiresJudge === undefined ? {} : { requiresJudge }),
  });
  if (Result.isFailure(planned)) throw new Error(planned.failure);
  let next = ledger;
  for (const event of planned.success) {
    next = applyLedgerEvent(next, {
      ...ledgerEventFromPlan(event, {
        threadId,
        providerInstanceId: ProviderInstanceId.make("planner"),
        occurredAt: now,
      }),
      id: EventId.make(`event:${event.type}`),
    });
  }
  return { ledger: next!, planned: planned.success };
}

const startCommand: LedgerCommand = {
  type: "ledger.investigation.start",
  commandId,
  threadId,
  ledgerId,
  goal: "Find why the sync job drops rows",
  solvedWhen: "A failing test reproduces the drop and passes with the fix.",
  budget: { minutes: 30 },
  parallelApproaches: 3,
};

/** A running investigation with approaches a, b and c, and a's thesis waiting on the refuter. */
function running(): Ledger {
  let ledger = step(undefined, startCommand, start, true).ledger;
  ledger = step(
    ledger,
    {
      type: "ledger.item.add",
      commandId,
      threadId,
      ledgerId,
      items: ["a", "b", "c"].map((name) => ({
        id: id(name),
        title: `Approach ${name}`,
        acceptance: "thesis",
        parentItemId: APPROACHES_ITEM_ID,
      })),
    },
    at(1),
  ).ledger;
  return step(
    ledger,
    {
      type: "ledger.item.update",
      commandId,
      threadId,
      ledgerId,
      itemId: id("a"),
      status: "closed",
      evidence: "Rows drop when the batch crosses a page boundary.",
      createdBy: "agent",
    },
    at(2),
  ).ledger;
}

const recordVerdict = (name: string, outcome: "pass" | "fail"): LedgerCommand => ({
  type: "ledger.item.verdict.record",
  commandId,
  threadId,
  ledgerId,
  itemId: id(name),
  verdict: verdict(outcome),
});

const statusOf = (ledger: Ledger, name: string) =>
  ledger.items.find((item) => item.id === id(name))?.status;

describe("investigation state machine", () => {
  it("starts with the criteria as the win condition and refuses a ledger without a judge", () => {
    const { ledger } = step(undefined, startCommand, start, true);
    assert.strictEqual(ledger.investigation?.status, "running");
    assert.deepStrictEqual(ledger.winConditions, [
      startCommand.type === "ledger.investigation.start" ? startCommand.solvedWhen : "",
    ]);
    assert.strictEqual(ledger.requiresJudge, true);
    const refused = planLedgerCommand({
      command: startCommand,
      ledger: undefined,
      now: start,
      requiresJudge: false,
    });
    assert.isTrue(Result.isFailure(refused));
  });

  it("a thesis waits on the refuter, and a FAIL hands the approach back refuted", () => {
    const thesis = running();
    assert.strictEqual(
      investigationLanes(thesis).find((lane) => lane.item.id === id("a"))?.status,
      "judging",
    );
    const { ledger, planned } = step(thesis, recordVerdict("a", "fail"), at(3));
    assert.strictEqual(statusOf(ledger, "a"), "in_progress");
    assert.strictEqual(ledger.investigation?.status, "running");
    assert.strictEqual(ledger.closedAt, null);
    assert.strictEqual(
      investigationLanes(ledger).find((lane) => lane.item.id === id("a"))?.status,
      "refuted",
    );
    assert.deepStrictEqual(investigationEffects({ commandId, threadId }, planned), []);
  });

  it("the first PASS solves it, drops the other approaches and stops every child", () => {
    const { ledger, planned } = step(running(), recordVerdict("a", "pass"), at(4));
    assert.strictEqual(ledger.investigation?.status, "solved");
    assert.strictEqual(ledger.investigation?.solvedItemId, id("a"));
    assert.strictEqual(statusOf(ledger, "a"), "closed");
    assert.strictEqual(statusOf(ledger, "b"), "dropped");
    assert.strictEqual(statusOf(ledger, "c"), "dropped");
    assert.strictEqual(statusOf(ledger, "approaches"), "closed");
    assert.notStrictEqual(ledger.closedAt, null);
    const effects = investigationEffects({ commandId, threadId }, planned);
    assert.deepStrictEqual(
      effects.map((effect) => effect.request.type),
      ["delegated-tasks.stop"],
    );
  });

  it("budget exhaustion ends it exhausted and stops every child; a later end is a no-op", () => {
    const thesis = running();
    const use = investigationBudgetUse({
      investigation: thesis.investigation!,
      nowMs: DateTime.toEpochMillis(at(30)),
      spentUsd: 0,
    });
    assert.strictEqual(use.exhausted, "time");
    const end: LedgerCommand = {
      type: "ledger.investigation.end",
      commandId,
      threadId,
      ledgerId,
      status: "exhausted",
      reason: "The 30 minute budget is used up.",
    };
    const { ledger, planned } = step(thesis, end, at(30));
    assert.strictEqual(ledger.investigation?.status, "exhausted");
    for (const name of ["a", "b", "c", "approaches"])
      assert.strictEqual(statusOf(ledger, name), "dropped");
    assert.strictEqual(
      ledger.items.some((item) => item.judging === true),
      false,
    );
    assert.strictEqual(investigationEffects({ commandId, threadId }, planned).length, 1);
    const again = planLedgerCommand({ command: end, ledger, now: at(31) });
    assert.isTrue(Result.isSuccess(again) && again.success.length === 0);
  });

  it("Stop all ends it stopped and stops every child", () => {
    const { ledger, planned } = step(
      running(),
      {
        type: "ledger.investigation.end",
        commandId,
        threadId,
        ledgerId,
        status: "stopped",
        reason: "Stopped by the user.",
      },
      at(5),
    );
    assert.strictEqual(ledger.investigation?.status, "stopped");
    assert.strictEqual(statusOf(ledger, "b"), "dropped");
    assert.strictEqual(investigationEffects({ commandId, threadId }, planned).length, 1);
  });

  it("refuses approaches beyond the parallel limit until one is refuted", () => {
    const addVariant: LedgerCommand = {
      type: "ledger.item.add",
      commandId,
      threadId,
      ledgerId,
      items: [
        { id: id("d"), title: "Approach d", acceptance: "", parentItemId: APPROACHES_ITEM_ID },
      ],
    };
    const full = running();
    assert.isTrue(
      Result.isFailure(planLedgerCommand({ command: addVariant, ledger: full, now: at(6) })),
    );
    const refuted = step(full, recordVerdict("a", "fail"), at(7)).ledger;
    assert.isTrue(
      Result.isSuccess(planLedgerCommand({ command: addVariant, ledger: refuted, now: at(8) })),
    );
  });
});
