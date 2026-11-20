import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type Ledger,
  LedgerId,
  LedgerItemId,
  type LedgerItem,
  type LedgerItemVerdict,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { type LedgerCommand, planLedgerCommand } from "./TaskLedger.ts";

const earlier = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const now = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z");
const threadId = ThreadId.make("thread:ledger-plan");
const ledgerId = LedgerId.make("ledger:plan");
const itemId = LedgerItemId.make("item:plan");

const verdict = (outcome: "pass" | "fail"): LedgerItemVerdict => ({
  outcome,
  judge: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  notes: "",
  at: earlier,
});

const item = (overrides: Partial<LedgerItem> = {}): LedgerItem => ({
  id: itemId,
  title: "Plan item",
  acceptance: "works",
  status: "in_progress",
  evidence: "ran the suite",
  dropReason: null,
  verdict: null,
  createdAt: earlier,
  updatedAt: earlier,
  closedAt: null,
  ...overrides,
});

const ledgerWith = (overrides: Partial<LedgerItem> = {}): Ledger => ({
  id: ledgerId,
  threadId,
  title: "Plan",
  startState: "",
  checkpoints: [],
  winConditions: [],
  items: [item(overrides)],
  createdAt: earlier,
  updatedAt: earlier,
  closedAt: null,
});

const closeItem: LedgerCommand = {
  type: "ledger.item.update",
  commandId: CommandId.make("command:plan:close"),
  threadId,
  ledgerId,
  itemId,
  status: "closed",
  // The agent's close: the judge gate applies to it, while a user's close is final.
  createdBy: "agent",
};

describe("planLedgerCommand judge gate", () => {
  it("lets an item close without a verdict when the ledger does not require a judge", () => {
    const planned = planLedgerCommand({ command: closeItem, ledger: ledgerWith(), now });
    assert.isTrue(Result.isSuccess(planned));
    const explicit = planLedgerCommand({
      command: closeItem,
      ledger: ledgerWith(),
      now,
      requiresJudge: false,
    });
    assert.isTrue(Result.isSuccess(explicit));
  });

  it("starts a judgement instead of closing without a verdict or after a failing one", () => {
    for (const verdictOnItem of [null, verdict("fail")]) {
      const planned = planLedgerCommand({
        command: closeItem,
        ledger: ledgerWith({ verdict: verdictOnItem }),
        now,
        requiresJudge: true,
      });
      const next =
        Result.isSuccess(planned) && planned.success[0]?.type === "ledger.item.updated"
          ? planned.success[0].payload.item
          : undefined;
      assert.equal(next?.status, "in_progress");
      assert.isTrue(next?.judging);
    }
  });

  it("closes with a passing verdict when a judge is required, and the verdict alone closes nothing", () => {
    const closed = planLedgerCommand({
      command: closeItem,
      ledger: ledgerWith({ verdict: verdict("pass") }),
      now,
      requiresJudge: true,
    });
    assert.isTrue(Result.isSuccess(closed));
    const events = Result.isSuccess(closed) ? closed.success : [];
    assert.equal(events[0]?.type, "ledger.item.updated");
    assert.equal(
      events[0]?.type === "ledger.item.updated" ? events[0].payload.item.status : undefined,
      "closed",
    );

    const recorded = planLedgerCommand({
      command: {
        type: "ledger.item.verdict.record",
        commandId: CommandId.make("command:plan:verdict"),
        threadId,
        ledgerId,
        itemId,
        verdict: verdict("pass"),
      },
      ledger: ledgerWith(),
      now,
      requiresJudge: true,
    });
    const recordedItem =
      Result.isSuccess(recorded) && recorded.success[0]?.type === "ledger.item.updated"
        ? recorded.success[0].payload.item
        : undefined;
    assert.equal(recordedItem?.status, "in_progress");
    assert.equal(recordedItem?.verdict?.outcome, "pass");
  });

  it("invalidates the verdict when the evidence changes after it was given", () => {
    const planned = planLedgerCommand({
      command: {
        type: "ledger.item.update",
        commandId: CommandId.make("command:plan:evidence"),
        threadId,
        ledgerId,
        itemId,
        evidence: "a different run",
      },
      ledger: ledgerWith({ verdict: verdict("pass") }),
      now,
      requiresJudge: true,
    });
    const next =
      Result.isSuccess(planned) && planned.success[0]?.type === "ledger.item.updated"
        ? planned.success[0].payload.item
        : undefined;
    assert.equal(next?.evidence, "a different run");
    assert.isNull(next?.verdict);

    const closing = planLedgerCommand({
      command: { ...closeItem, evidence: "a different run" },
      ledger: ledgerWith({ verdict: verdict("pass") }),
      now,
      requiresJudge: true,
    });
    const judging =
      Result.isSuccess(closing) && closing.success[0]?.type === "ledger.item.updated"
        ? closing.success[0].payload.item
        : undefined;
    assert.equal(judging?.status, "in_progress");
    assert.isTrue(judging?.judging);
    assert.isNull(judging?.verdict);
  });
});

describe("planLedgerCommand ledger-level judge requirement", () => {
  it("gates a close on the ledger's own requiresJudge with no parameter passed", () => {
    const judged = planLedgerCommand({
      command: closeItem,
      ledger: { ...ledgerWith(), requiresJudge: true },
      now,
    });
    assert.isTrue(
      Result.isSuccess(judged) &&
        judged.success[0]?.type === "ledger.item.updated" &&
        judged.success[0].payload.item.judging === true,
    );

    const passed = planLedgerCommand({
      command: closeItem,
      ledger: { ...ledgerWith({ verdict: verdict("pass") }), requiresJudge: true },
      now,
    });
    assert.isTrue(Result.isSuccess(passed));

    // Older records carry no field and close as before.
    assert.isTrue(
      Result.isSuccess(planLedgerCommand({ command: closeItem, ledger: ledgerWith(), now })),
    );
  });

  it("stamps the new ledger from the value the server decided at creation", () => {
    const create: LedgerCommand = {
      type: "ledger.create",
      commandId: CommandId.make("command:plan:create"),
      threadId,
      ledgerId,
      title: "Judged",
      startState: "",
      checkpoints: [],
      winConditions: [],
      items: [],
    };
    const stamped = (requiresJudge?: boolean) => {
      const planned = planLedgerCommand({
        command: create,
        ledger: undefined,
        now,
        ...(requiresJudge === undefined ? {} : { requiresJudge }),
      });
      return (
        Result.isSuccess(planned) &&
        planned.success[0]?.type === "ledger.created" &&
        planned.success[0].payload.requiresJudge === true
      );
    };
    assert.isTrue(stamped(true));
    assert.isFalse(stamped(false));
    assert.isFalse(stamped());

    // A replacement ledger never inherits the closed one's requirement.
    const replaced = planLedgerCommand({
      command: { ...create, ledgerId: LedgerId.make("ledger:next") },
      ledger: { ...ledgerWith(), requiresJudge: true, closedAt: earlier },
      now,
    });
    assert.isTrue(
      Result.isSuccess(replaced) &&
        replaced.success[0]?.type === "ledger.created" &&
        replaced.success[0].payload.requiresJudge !== true,
    );
  });

  it("counts every recorded verdict, across new evidence and reopening", () => {
    const record = (ledger: Ledger, outcome: "pass" | "fail") => {
      const planned = planLedgerCommand({
        command: {
          type: "ledger.item.verdict.record",
          commandId: CommandId.make(`command:plan:count:${outcome}`),
          threadId,
          ledgerId,
          itemId,
          verdict: verdict(outcome),
        },
        ledger,
        now,
      });
      return Result.isSuccess(planned) && planned.success[0]?.type === "ledger.item.updated"
        ? planned.success[0].payload.item
        : undefined;
    };
    const first = record(ledgerWith(), "fail");
    assert.equal(first?.judgements, 1);
    const second = record(
      { ...ledgerWith(), items: [item({ ...first, evidence: "second run", verdict: null })] },
      "fail",
    );
    assert.equal(second?.judgements, 2);
  });

  it("restarts the failure baseline when an item is reopened or passes", () => {
    const updated = (command: LedgerCommand, ledger: Ledger) => {
      const planned = planLedgerCommand({ command, ledger, now });
      return Result.isSuccess(planned) && planned.success[0]?.type === "ledger.item.updated"
        ? planned.success[0].payload.item
        : undefined;
    };
    const reopened = updated(
      {
        type: "ledger.item.update",
        commandId: CommandId.make("command:plan:reopen"),
        threadId,
        ledgerId,
        itemId,
        status: "open",
      },
      ledgerWith({ status: "closed", closedAt: earlier, verdict: verdict("fail"), judgements: 3 }),
    );
    assert.equal(reopened?.judgements, 3);
    assert.equal(reopened?.judgementsAtReopen, 3);

    const passed = updated(
      {
        type: "ledger.item.verdict.record",
        commandId: CommandId.make("command:plan:baseline-pass"),
        threadId,
        ledgerId,
        itemId,
        verdict: verdict("pass"),
      },
      ledgerWith({ verdict: verdict("fail"), judgements: 2 }),
    );
    assert.equal(passed?.judgementsAtReopen, 3);

    const failed = updated(
      {
        type: "ledger.item.verdict.record",
        commandId: CommandId.make("command:plan:baseline-fail"),
        threadId,
        ledgerId,
        itemId,
        verdict: verdict("fail"),
      },
      ledgerWith({ judgements: 3, judgementsAtReopen: 3 }),
    );
    assert.equal(failed?.judgements, 4);
    assert.equal(failed?.judgementsAtReopen, 3);
  });

  it("refuses a verdict for evidence that changed while the judge was working", () => {
    const record = (judgedEvidence: string | null): LedgerCommand => ({
      type: "ledger.item.verdict.record",
      commandId: CommandId.make("command:plan:judged"),
      threadId,
      ledgerId,
      itemId,
      verdict: verdict("pass"),
      judgedEvidence,
    });
    const stale = planLedgerCommand({ command: record("an older run"), ledger: ledgerWith(), now });
    assert.isTrue(Result.isFailure(stale));
    assert.include(Result.isFailure(stale) ? stale.failure : "", "evidence changed");
    assert.isTrue(
      Result.isSuccess(
        planLedgerCommand({ command: record("ran the suite"), ledger: ledgerWith(), now }),
      ),
    );
  });
});

describe("planLedgerCommand ask check", () => {
  const idOf = (name: string) => LedgerItemId.make(`item:${name}`);
  const named = (name: string, overrides: Partial<LedgerItem> = {}) =>
    item({ id: idOf(name), title: name, ...overrides });
  const ask = (name: string, overrides: Partial<LedgerItem> = {}) =>
    named(name, { quote: `quote of ${name}`, ...overrides });
  const checked = (items: ReadonlyArray<LedgerItem>, flags: Partial<Ledger> = {}): Ledger => ({
    ...ledgerWith(),
    askCheck: true,
    items,
    ...flags,
  });
  const closeOf = (name: string, evidence?: string): LedgerCommand => ({
    type: "ledger.item.update",
    commandId: CommandId.make(`command:plan:close:${name}`),
    threadId,
    ledgerId,
    itemId: idOf(name),
    status: "closed",
    createdBy: "agent",
    ...(evidence === undefined ? {} : { evidence }),
  });
  const closeUserOf = (name: string): LedgerCommand => ({
    type: "ledger.item.update",
    commandId: CommandId.make(`command:plan:user-close:${name}`),
    threadId,
    ledgerId,
    itemId: idOf(name),
    status: "closed",
  });
  const planned = (command: LedgerCommand, ledger: Ledger) => {
    const result = planLedgerCommand({ command, ledger, now });
    return Result.isSuccess(result) && result.success[0]?.type === "ledger.item.updated"
      ? result.success[0].payload.item
      : undefined;
  };

  it("holds the agent's close of the last unfinished ask as a judgement", () => {
    const next = planned(closeOf("b"), checked([ask("a", { status: "closed" }), ask("b")]));
    assert.equal(next?.status, "in_progress");
    assert.isTrue(next?.judging);
    assert.isNull(next?.verdict);
  });

  it("closes an earlier ask at once while another ask is unfinished", () => {
    const next = planned(closeOf("a"), checked([ask("a"), ask("b")]));
    assert.equal(next?.status, "closed");
    assert.isUndefined(next?.judging);
    // An ask being judged is unfinished too, so the one closing beside it is not the last.
    const beside = planned(
      closeOf("b"),
      checked([ask("a", { status: "in_progress", judging: true }), ask("b")]),
    );
    assert.equal(beside?.status, "closed");
  });

  it("closes a sub-item at once, even when it is the only unfinished item", () => {
    const ledger = checked([
      ask("a", { status: "in_progress" }),
      named("step", { parentItemId: idOf("a") }),
    ]);
    const next = planned(closeOf("step"), ledger);
    assert.equal(next?.status, "closed");
    // The step is not an ask, so closing the ask afterwards is what gets checked.
    const after = planned(
      closeOf("a"),
      checked([ask("a", { status: "in_progress" }), named("step", { status: "closed" })]),
    );
    assert.isTrue(after?.judging);
  });

  it("holds the last top-level item when the ledger has no ask, and only that one", () => {
    const first = planned(closeOf("one"), checked([named("one"), named("two")]));
    assert.equal(first?.status, "closed");
    const last = planned(
      closeOf("two"),
      checked([named("one", { status: "closed" }), named("two")]),
    );
    assert.equal(last?.status, "in_progress");
    assert.isTrue(last?.judging);
    const sub = planned(
      closeOf("sub"),
      checked([
        named("one", { status: "in_progress" }),
        named("sub", { parentItemId: idOf("one") }),
      ]),
    );
    assert.equal(sub?.status, "closed");
  });

  it("leaves a ledger with neither flag, and a judged ledger, as before", () => {
    const items = [ask("a", { status: "closed" }), ask("b")];
    const plain = planned(closeOf("b"), checked(items, { askCheck: false }));
    assert.equal(plain?.status, "closed");
    // A judged ledger gates every close, not only the last ask; the ask check adds nothing to it.
    const judged = planned(
      closeOf("a"),
      checked([ask("a"), ask("b")], { askCheck: false, requiresJudge: true }),
    );
    assert.isTrue(judged?.judging);
    const both = planned(closeOf("a"), checked([ask("a"), ask("b")], { requiresJudge: true }));
    assert.isTrue(both?.judging);
  });

  it("leaves every other change of an ask check ledger as it was", () => {
    const ledger = checked([ask("a"), named("plan", { status: "in_progress" })]);
    const update = (itemName: string, status: LedgerItem["status"], extra = {}): LedgerCommand => ({
      type: "ledger.item.update",
      commandId: CommandId.make(`command:plan:${itemName}:${status}`),
      threadId,
      ledgerId,
      itemId: idOf(itemName),
      status,
      createdBy: "agent",
      ...extra,
    });
    // Started work goes back to open, and a plan step is dropped or deferred, with no judge.
    assert.equal(planned(update("plan", "open"), ledger)?.status, "open");
    assert.equal(
      planned(update("plan", "dropped", { dropReason: "not needed" }), ledger)?.status,
      "dropped",
    );
    assert.equal(
      planned(update("plan", "deferred", { deferReason: "later" }), ledger)?.status,
      "deferred",
    );
    // An ask still cannot be dropped by the agent.
    const refused = planLedgerCommand({
      command: update("a", "dropped", { dropReason: "no" }),
      ledger,
      now,
    });
    assert.isTrue(Result.isFailure(refused));
  });

  it("keeps the user's own close final", () => {
    const next = planned(closeUserOf("b"), checked([ask("a", { status: "closed" }), ask("b")]));
    assert.equal(next?.status, "closed");
    assert.isUndefined(next?.judging);
  });

  it("lets a close through on a pass for unchanged evidence, and holds it again on new evidence", () => {
    const passing = checked([
      ask("a", { status: "closed" }),
      ask("b", { verdict: verdict("pass") }),
    ]);
    assert.equal(planned(closeOf("b"), passing)?.status, "closed");
    const changed = planned(closeOf("b", "something new"), passing);
    assert.isTrue(changed?.judging);
    assert.isNull(changed?.verdict);
  });

  it("checks the next last ask again when a new ask is added after a pass", () => {
    const afterPass = checked([ask("a", { status: "closed", verdict: verdict("pass") })]);
    const add: LedgerCommand = {
      type: "ledger.item.add",
      commandId: CommandId.make("command:plan:add-ask"),
      threadId,
      ledgerId,
      items: [{ id: idOf("late"), title: "late", acceptance: "works", quote: "a later ask" }],
    };
    const added = planLedgerCommand({ command: add, ledger: afterPass, now });
    assert.isTrue(Result.isSuccess(added));
    const grown = {
      ...afterPass,
      items: [
        ...afterPass.items,
        ask("late", { status: "in_progress", createdAt: now, updatedAt: now }),
      ],
    };
    const next = planned(closeOf("late"), grown);
    assert.isTrue(next?.judging);
  });

  it("stamps the new ledger only from the value the server decided, and never beside a judge", () => {
    const create: LedgerCommand = {
      type: "ledger.create",
      commandId: CommandId.make("command:plan:create-checked"),
      threadId,
      ledgerId,
      title: "Checked",
      startState: "",
      checkpoints: [],
      winConditions: [],
      items: [],
    };
    const stamp = (flags: { requiresJudge?: boolean; askCheck?: boolean }) => {
      const result = planLedgerCommand({ command: create, ledger: undefined, now, ...flags });
      const created =
        Result.isSuccess(result) && result.success[0]?.type === "ledger.created"
          ? result.success[0].payload
          : undefined;
      return [created?.askCheck === true, created?.requiresJudge === true];
    };
    assert.deepEqual(stamp({ askCheck: true }), [true, false]);
    assert.deepEqual(stamp({ askCheck: false }), [false, false]);
    assert.deepEqual(stamp({}), [false, false]);
    assert.deepEqual(stamp({ askCheck: true, requiresJudge: true }), [false, true]);

    // A replacement ledger never inherits the closed one's flag.
    const replaced = planLedgerCommand({
      command: { ...create, ledgerId: LedgerId.make("ledger:next") },
      ledger: { ...ledgerWith(), askCheck: true, closedAt: earlier },
      now,
    });
    assert.isTrue(
      Result.isSuccess(replaced) &&
        replaced.success[0]?.type === "ledger.created" &&
        replaced.success[0].payload.askCheck !== true,
    );
  });
});

describe("planLedgerCommand ask check policy v2", () => {
  const idOf = (name: string) => LedgerItemId.make(`item:${name}`);
  const ask = (name: string, overrides: Partial<LedgerItem> = {}) =>
    item({ id: idOf(name), title: name, quote: `quote of ${name}`, ...overrides });
  const v2Ledger = (items: ReadonlyArray<LedgerItem>, flags: Partial<Ledger> = {}): Ledger => ({
    ...ledgerWith(),
    askCheck: true,
    askCheckPolicy: "v2",
    items,
    ...flags,
  });
  const failOn = (name: string, extra: { handOver?: { from: string; to: string } } = {}) =>
    ({
      type: "ledger.item.verdict.record",
      commandId: CommandId.make(`command:plan:v2-fail:${name}`),
      threadId,
      ledgerId,
      itemId: idOf(name),
      verdict: verdict("fail"),
      ...extra,
    }) satisfies LedgerCommand;
  const events = (command: LedgerCommand, ledger: Ledger) => {
    const result = planLedgerCommand({ command, ledger, now });
    assert.isTrue(Result.isSuccess(result), Result.isFailure(result) ? result.failure : "");
    return Result.isSuccess(result) ? result.success : [];
  };
  const askCheckUpdate = (command: LedgerCommand, ledger: Ledger) => {
    const found = events(command, ledger).find(({ type }) => type === "ledger.ask-check.updated");
    return found?.type === "ledger.ask-check.updated" ? found.payload : undefined;
  };
  const closeBy = (name: string, createdBy?: "agent"): LedgerCommand => ({
    type: "ledger.item.update",
    commandId: CommandId.make(`command:plan:v2-close:${name}:${createdBy ?? "user"}`),
    threadId,
    ledgerId,
    itemId: idOf(name),
    status: "closed",
    ...(createdBy === undefined ? {} : { createdBy }),
  });
  const STOP_TEXT =
    "The check failed three times and has stopped. Tell the user what is done, what the last check found (ledger_read has its notes) and what you would try next; do not keep changing code for this item unless they ask.";

  it("stamps the policy at creation only beside an ask check", () => {
    const create: LedgerCommand = {
      type: "ledger.create",
      commandId: CommandId.make("command:plan:create-v2"),
      threadId,
      ledgerId,
      title: "Checked",
      startState: "",
      checkpoints: [],
      winConditions: [],
      items: [],
    };
    const stamp = (flags: {
      requiresJudge?: boolean;
      askCheck?: boolean;
      askCheckPolicy?: "v2";
    }) => {
      const result = planLedgerCommand({ command: create, ledger: undefined, now, ...flags });
      return Result.isSuccess(result) && result.success[0]?.type === "ledger.created"
        ? result.success[0].payload.askCheckPolicy
        : "not created";
    };
    assert.equal(stamp({ askCheck: true, askCheckPolicy: "v2" }), "v2");
    assert.isUndefined(stamp({ askCheck: true }));
    assert.isUndefined(stamp({ askCheckPolicy: "v2" }));
    assert.isUndefined(stamp({ askCheck: true, requiresJudge: true, askCheckPolicy: "v2" }));
  });

  it("counts failed checks for the ledger across items and across a reopen", () => {
    const ledger = v2Ledger([ask("a"), ask("b")]);
    assert.equal(askCheckUpdate(failOn("a"), ledger)?.fails, 1);
    // A second failed check on another item adds to the same count.
    const afterFirst = v2Ledger([ask("a"), ask("b")], { askCheckFails: 1 });
    assert.equal(askCheckUpdate(failOn("b"), afterFirst)?.fails, 2);
    // Reopening a closed item plans no ask check change, so the count stands.
    const reopened = events(
      {
        type: "ledger.item.update",
        commandId: CommandId.make("command:plan:v2-reopen"),
        threadId,
        ledgerId,
        itemId: idOf("a"),
        status: "open",
      },
      v2Ledger([ask("a", { status: "closed", closedAt: earlier }), ask("b")], {
        askCheckFails: 2,
      }),
    );
    assert.isFalse(reopened.some(({ type }) => type === "ledger.ask-check.updated"));
    // A pass is not a failed check.
    const pass = events({ ...failOn("a"), verdict: verdict("pass") }, ledger);
    assert.isFalse(pass.some(({ type }) => type === "ledger.ask-check.updated"));
  });

  it("leaves a v1 ledger and a judged ledger uncounted", () => {
    const v1: Ledger = { ...ledgerWith(), askCheck: true, items: [ask("a")] };
    assert.isUndefined(askCheckUpdate(failOn("a"), v1));
    const judged = v2Ledger([ask("a")], { askCheck: false, requiresJudge: true });
    assert.isUndefined(askCheckUpdate(failOn("a"), judged));
  });

  it("records the hand-over on the second failed check, and only then", () => {
    const handOver = { from: "claude-sonnet-5-5", to: "claude-opus-5-5" };
    const second = askCheckUpdate(
      failOn("a", { handOver }),
      v2Ledger([ask("a")], { askCheckFails: 1 }),
    );
    assert.equal(second?.fails, 2);
    assert.deepEqual(second?.handedOver, { ...handOver, at: now });
    assert.isUndefined(second?.stopped);
    // Without a stronger checker the server passes none, and nothing is recorded.
    assert.isUndefined(
      askCheckUpdate(failOn("a"), v2Ledger([ask("a")], { askCheckFails: 1 }))?.handedOver,
    );
    // The first fail never hands over, even when asked to.
    assert.isUndefined(askCheckUpdate(failOn("a", { handOver }), v2Ledger([ask("a")]))?.handedOver);
  });

  it("stops the ledger on the third failed check and keeps the hand-over record", () => {
    const handedOver = { from: "sonnet", to: "opus", at: earlier };
    const third = askCheckUpdate(
      failOn("a"),
      v2Ledger([ask("a")], { askCheckFails: 2, askCheckHandedOver: handedOver }),
    );
    assert.equal(third?.fails, 3);
    assert.deepEqual(third?.stopped, { at: now, fails: 3 });
    assert.deepEqual(third?.handedOver, handedOver);
  });

  it("refuses the agent's close of the held ask while stopped, and only that", () => {
    const stopped = v2Ledger(
      [ask("a", { status: "closed", closedAt: earlier }), ask("b"), ask("c")],
      { askCheckFails: 3, askCheckStopped: { at: earlier, fails: 3 } },
    );
    // With another ask unfinished the close is not the checked one, so it is immediate.
    assert.isTrue(
      Result.isSuccess(planLedgerCommand({ command: closeBy("b", "agent"), ledger: stopped, now })),
    );
    const held = v2Ledger([ask("a", { status: "closed", closedAt: earlier }), ask("b")], {
      askCheckFails: 3,
      askCheckStopped: { at: earlier, fails: 3 },
    });
    const refused = planLedgerCommand({ command: closeBy("b", "agent"), ledger: held, now });
    assert.isTrue(Result.isFailure(refused));
    assert.equal(Result.isFailure(refused) ? refused.failure : "", STOP_TEXT);
    // The user's own close is final.
    const byUser = planLedgerCommand({ command: closeBy("b"), ledger: held, now });
    assert.isTrue(Result.isSuccess(byUser));
    // Before the stop the same close is held for a check, as on v1.
    const unstopped = planLedgerCommand({
      command: closeBy("b", "agent"),
      ledger: v2Ledger([ask("a", { status: "closed", closedAt: earlier }), ask("b")]),
      now,
    });
    assert.isTrue(Result.isSuccess(unstopped));
  });

  it("clears the stop when the user writes, resetting nothing else", () => {
    const resume = (ledger: Ledger) =>
      events(
        {
          type: "ledger.ask-check.resume",
          commandId: CommandId.make("command:plan:v2-resume"),
          threadId,
          ledgerId,
        },
        ledger,
      );
    const handedOver = { from: "sonnet", to: "opus", at: earlier };
    const cleared = resume(
      v2Ledger([ask("a")], {
        askCheckFails: 3,
        askCheckHandedOver: handedOver,
        askCheckStopped: { at: earlier, fails: 3 },
      }),
    ).find(({ type }) => type === "ledger.ask-check.updated");
    assert.equal(cleared?.type === "ledger.ask-check.updated" ? cleared.payload.fails : -1, 3);
    assert.isUndefined(cleared?.type === "ledger.ask-check.updated" && cleared.payload.stopped);
    assert.deepEqual(
      cleared?.type === "ledger.ask-check.updated" ? cleared.payload.handedOver : undefined,
      handedOver,
    );
    // Nothing is stopped, nothing changes.
    assert.deepEqual(resume(v2Ledger([ask("a")], { askCheckFails: 1 })), []);
    assert.deepEqual(resume({ ...ledgerWith(), askCheck: true, items: [ask("a")] }), []);
  });
});

describe("planLedgerCommand no-ops", () => {
  it("plans nothing for a checkpoint already in the requested state or an unchanged item", () => {
    const ledger: Ledger = {
      ...ledgerWith(),
      checkpoints: [
        {
          id: "checkpoint:plan" as Ledger["checkpoints"][number]["id"],
          title: "Reached",
          reached: true,
          reachedAt: earlier,
        },
      ],
    };
    const checkpoint = planLedgerCommand({
      command: {
        type: "ledger.checkpoint.set",
        commandId: CommandId.make("command:plan:checkpoint"),
        threadId,
        ledgerId,
        checkpointId: ledger.checkpoints[0]!.id,
        reached: true,
      },
      ledger,
      now,
    });
    assert.deepEqual(Result.isSuccess(checkpoint) ? checkpoint.success : "failed", []);

    const unchanged = planLedgerCommand({
      command: { ...closeItem, status: "in_progress" },
      ledger,
      now,
    });
    assert.deepEqual(Result.isSuccess(unchanged) ? unchanged.success : "failed", []);
  });
});
