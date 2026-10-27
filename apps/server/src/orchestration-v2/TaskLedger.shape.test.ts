import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type Ledger,
  LedgerId,
  LedgerItemId,
  type LedgerItem,
  type LedgerItemVerdict,
  LedgerJson,
  NodeId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  type LedgerCommand,
  ledgerJudgeEffects,
  ledgerTaskLinkProblem,
  planLedgerCommand,
} from "./TaskLedger.ts";

const earlier = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const now = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z");
const threadId = ThreadId.make("thread:ledger-shape");
const ledgerId = LedgerId.make("ledger:shape");
const id = (name: string) => LedgerItemId.make(name);
const commandId = CommandId.make("command:shape");
const decodeLedgerJson = Schema.decodeSync(LedgerJson);
const encodeLedgerJson = Schema.encodeSync(LedgerJson);

const item = (name: string, overrides: Partial<LedgerItem> = {}): LedgerItem => ({
  id: id(name),
  title: `Item ${name}`,
  acceptance: "works",
  status: "open",
  evidence: null,
  dropReason: null,
  verdict: null,
  createdAt: earlier,
  updatedAt: earlier,
  closedAt: null,
  ...overrides,
});

const ledgerOf = (items: ReadonlyArray<LedgerItem>, requiresJudge = false): Ledger => ({
  id: ledgerId,
  threadId,
  title: "Shape",
  startState: "",
  checkpoints: [],
  winConditions: [],
  items,
  ...(requiresJudge ? { requiresJudge: true } : {}),
  createdAt: earlier,
  updatedAt: earlier,
  closedAt: null,
});

type UpdateFields = Omit<
  Extract<LedgerCommand, { type: "ledger.item.update" }>,
  "type" | "commandId" | "threadId" | "ledgerId" | "itemId"
>;
const update = (name: string, fields: UpdateFields): LedgerCommand => ({
  type: "ledger.item.update",
  commandId,
  threadId,
  ledgerId,
  itemId: id(name),
  ...fields,
});

const add = (
  drafts: ReadonlyArray<Extract<LedgerCommand, { type: "ledger.item.add" }>["items"][number]>,
): LedgerCommand => ({ type: "ledger.item.add", commandId, threadId, ledgerId, items: drafts });

const draft = (
  name: string,
  extra: Partial<{ blockedBy: string[]; parentItemId: string }> = {},
) => ({
  id: id(name),
  title: `Item ${name}`,
  acceptance: "works",
  ...(extra.blockedBy === undefined ? {} : { blockedBy: extra.blockedBy.map(id) }),
  ...(extra.parentItemId === undefined ? {} : { parentItemId: id(extra.parentItemId) }),
});

const plan = (command: LedgerCommand, ledger: Ledger) =>
  planLedgerCommand({ command, ledger, now });

const failureOf = (planned: ReturnType<typeof plan>) =>
  Result.isFailure(planned) ? planned.failure : "";

const updatedItem = (planned: ReturnType<typeof plan>) =>
  Result.isSuccess(planned) && planned.success[0]?.type === "ledger.item.updated"
    ? planned.success[0].payload.item
    : undefined;

describe("ledger blockers", () => {
  const ledger = ledgerOf([
    item("L1"),
    item("L2", { status: "in_progress" }),
    item("L3", { blockedBy: [id("L1"), id("L2")] }),
  ]);

  it("refuses to start or close an item while a blocker is unfinished, naming the blockers", () => {
    const start = plan(update("L3", { status: "in_progress" }), ledger);
    assert.isTrue(Result.isFailure(start));
    assert.include(failureOf(start), "L1");
    assert.include(failureOf(start), "L2");
    const close = plan(update("L3", { status: "closed", evidence: "done" }), ledger);
    assert.isTrue(Result.isFailure(close));
    assert.include(failureOf(close), "blocked");
  });

  it("unblocks once every blocker is closed or dropped", () => {
    const settled = ledgerOf([
      item("L1", { status: "closed", evidence: "ok", closedAt: earlier }),
      item("L2", { status: "dropped", dropReason: "moot" }),
      item("L3", { blockedBy: [id("L1"), id("L2")] }),
    ]);
    assert.equal(
      updatedItem(plan(update("L3", { status: "in_progress" }), settled))?.status,
      "in_progress",
    );
  });

  it("a deferred blocker still blocks", () => {
    const deferredBlocker = ledgerOf([
      item("L1", { status: "deferred", deferReason: "later" }),
      item("L3", { blockedBy: [id("L1")] }),
    ]);
    assert.isTrue(Result.isFailure(plan(update("L3", { status: "in_progress" }), deferredBlocker)));
  });

  it("rejects unknown blocker ids, self blocks and cycles", () => {
    assert.include(failureOf(plan(add([draft("L4", { blockedBy: ["nope"] })]), ledger)), "nope");
    assert.include(failureOf(plan(update("L1", { blockedBy: [id("L1")] }), ledger)), "itself");
    const cycle = plan(update("L1", { blockedBy: [id("L3")] }), ledger);
    assert.isTrue(Result.isFailure(cycle));
    assert.include(failureOf(cycle), "cycle");
  });

  it("accepts blockers among items added in the same batch, and replaces the list on update", () => {
    const added = plan(add([draft("L4", { blockedBy: ["L5"] }), draft("L5")]), ledger);
    assert.isTrue(Result.isSuccess(added));
    const cleared = updatedItem(plan(update("L3", { blockedBy: [] }), ledger));
    assert.deepEqual(cleared?.blockedBy ?? [], []);
  });

  it("rejects a cycle created inside a single create", () => {
    const created = planLedgerCommand({
      command: {
        type: "ledger.create",
        commandId,
        threadId,
        ledgerId,
        title: "Cyclic",
        startState: "",
        checkpoints: [],
        winConditions: [],
        items: [draft("A", { blockedBy: ["B"] }), draft("B", { blockedBy: ["A"] })],
      },
      ledger: undefined,
      now,
    });
    assert.include(failureOf(created), "cycle");
  });
});

describe("ledger sub-items", () => {
  const ledger = ledgerOf([
    item("P", { status: "in_progress", evidence: "parts done" }),
    item("C1", { parentItemId: id("P") }),
    item("C2", { parentItemId: id("P"), status: "deferred", deferReason: "later" }),
  ]);

  it("keeps a parent open while a child is open or in progress", () => {
    const close = plan(update("P", { status: "closed" }), ledger);
    assert.isTrue(Result.isFailure(close));
    assert.include(failureOf(close), "C1");
    assert.notInclude(failureOf(close), "C2");
  });

  it("closes the parent once children are closed, dropped or deferred", () => {
    const done = ledgerOf([
      item("P", { status: "in_progress", evidence: "parts done" }),
      item("C1", { parentItemId: id("P"), status: "closed", evidence: "ok", closedAt: earlier }),
      item("C2", { parentItemId: id("P"), status: "deferred", deferReason: "later" }),
    ]);
    assert.equal(updatedItem(plan(update("P", { status: "closed" }), done))?.status, "closed");
  });

  it("rejects unknown parents, self parents and parent cycles", () => {
    assert.include(failureOf(plan(add([draft("X", { parentItemId: "ghost" })]), ledger)), "ghost");
    assert.include(failureOf(plan(update("P", { parentItemId: id("P") }), ledger)), "itself");
    assert.include(failureOf(plan(update("P", { parentItemId: id("C1") }), ledger)), "cycle");
  });

  it("moves an item to the top level with a null parent", () => {
    const moved = updatedItem(plan(update("C1", { parentItemId: null }), ledger));
    assert.isDefined(moved);
    assert.notProperty(moved ?? {}, "parentItemId");
  });

  it("refuses to add an unfinished child under a closed parent", () => {
    const closedParent = ledgerOf([
      item("P", { status: "closed", evidence: "ok", closedAt: earlier }),
    ]);
    assert.include(
      failureOf(plan(add([draft("C", { parentItemId: "P" })]), closedParent)),
      "closed",
    );
  });
});

describe("deferred items", () => {
  const ledger = ledgerOf([item("L1"), item("L2", { status: "in_progress" })]);

  it("defers with a reason and refuses without one", () => {
    assert.include(failureOf(plan(update("L1", { status: "deferred" }), ledger)), "deferReason");
    const deferred = updatedItem(
      plan(update("L2", { status: "deferred", deferReason: "next task" }), ledger),
    );
    assert.equal(deferred?.status, "deferred");
    assert.equal(deferred?.deferReason, "next task");
  });

  it("creates an item deferred from its draft", () => {
    const added = plan(add([{ ...draft("L9"), deferReason: "found while testing" }]), ledger);
    const addedItem =
      Result.isSuccess(added) && added.success[0]?.type === "ledger.item.added"
        ? added.success[0].payload.items[0]
        : undefined;
    assert.equal(addedItem?.status, "deferred");
    assert.equal(addedItem?.deferReason, "found while testing");
    assert.include(
      failureOf(plan(add([{ ...draft("L8"), deferReason: "  " }]), ledger)),
      "deferReason",
    );
  });

  it("reopens from deferred and clears the reason", () => {
    const reopened = updatedItem(
      plan(
        update("L1", { status: "open" }),
        ledgerOf([item("L1", { status: "deferred", deferReason: "later" })]),
      ),
    );
    assert.equal(reopened?.status, "open");
    assert.notProperty(reopened ?? {}, "deferReason");
  });

  it("lets the ledger close with deferred items left", () => {
    const closing = plan(
      { type: "ledger.close", commandId, threadId, ledgerId },
      ledgerOf([
        item("L1", { status: "closed", evidence: "ok", closedAt: earlier }),
        item("L2", { status: "deferred", deferReason: "later" }),
      ]),
    );
    assert.equal(Result.isSuccess(closing) ? closing.success[0]?.type : undefined, "ledger.closed");
  });

  it("refuses a deferReason when the item is not being deferred", () => {
    assert.include(
      failureOf(plan(update("L1", { status: "in_progress", deferReason: "x" }), ledger)),
      "deferReason",
    );
  });
});

describe("automatic judge", () => {
  const verdict = (outcome: "pass" | "fail", notes = ""): LedgerItemVerdict => ({
    outcome,
    judge: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    notes,
    at: now,
  });
  const judged = ledgerOf([item("L1", { status: "in_progress", evidence: "suite passed" })], true);
  // The stamp of the judging request the verdict answers: the judging item's `updatedAt`.
  const record = (
    outcome: "pass" | "fail",
    _ledger: Ledger,
    notes = "",
    /** Null for an unstamped verdict, as an explicit judgement records. */
    judgingRequestedAt: DateTime.Utc | null = earlier,
  ): LedgerCommand => ({
    type: "ledger.item.verdict.record",
    commandId,
    threadId,
    ledgerId,
    itemId: id("L1"),
    verdict: verdict(outcome, notes),
    judgedEvidence: "suite passed",
    ...(judgingRequestedAt === null ? {} : { judgingRequestedAt }),
  });
  const agentClose = (fields: UpdateFields = {}): LedgerCommand =>
    update("L1", { status: "closed", ...fields, createdBy: "agent" });

  it("turns the agent's close without a passing verdict into a judgement in progress", () => {
    const requested = updatedItem(plan(agentClose(), judged));
    assert.equal(requested?.status, "in_progress");
    assert.isTrue(requested?.judging);
    assert.isNull(requested?.closedAt ?? null);
  });

  it("closes directly when the user closes, judging or not", () => {
    const closed = updatedItem(plan(update("L1", { status: "closed" }), judged));
    assert.equal(closed?.status, "closed");
    assert.notProperty(closed ?? {}, "judging");
    const judging = ledgerOf(
      [item("L1", { status: "in_progress", evidence: "suite passed", judging: true })],
      true,
    );
    const overruled = updatedItem(plan(update("L1", { status: "closed" }), judging));
    assert.equal(overruled?.status, "closed");
    assert.notProperty(overruled ?? {}, "judging");
  });

  it("ignores a verdict that answers a different or settled judging request", () => {
    const judging = ledgerOf(
      [item("L1", { status: "in_progress", evidence: "suite passed", judging: true })],
      true,
    );
    const stale = plan(record("pass", judging, "", now), judging);
    assert.deepEqual(Result.isSuccess(stale) ? stale.success : "failed", []);
    const settled = plan(record("pass", judged), judged);
    assert.deepEqual(Result.isSuccess(settled) ? settled.success : "failed", []);
    // An unstamped verdict, the explicit judgement's, records without settling a request.
    const unstamped = updatedItem(plan(record("pass", judging, "", null), judging));
    assert.equal(unstamped?.status, "in_progress");
    assert.isTrue(unstamped?.judging);
  });

  it("treats the agent repeating its close while judging as already applied", () => {
    const judging = ledgerOf(
      [item("L1", { status: "in_progress", evidence: "suite passed", judging: true })],
      true,
    );
    const again = plan(agentClose(), judging);
    assert.deepEqual(Result.isSuccess(again) ? again.success : "failed", []);
    assert.include(
      failureOf(plan(update("L1", { evidence: "something else" }), judging)),
      "being judged",
    );
    assert.equal(
      updatedItem(plan(update("L1", { status: "dropped", dropReason: "moot" }), judging))?.status,
      "dropped",
    );
  });

  it("closes the item on a passing verdict", () => {
    const judging = ledgerOf(
      [item("L1", { status: "in_progress", evidence: "suite passed", judging: true })],
      true,
    );
    const closed = updatedItem(plan(record("pass", judging), judging));
    assert.equal(closed?.status, "closed");
    assert.notProperty(closed ?? {}, "judging");
    assert.isNotNull(closed?.closedAt ?? null);
    assert.equal(closed?.verdict?.outcome, "pass");
  });

  it("hands the item back in progress with the judge's notes on a failing verdict", () => {
    const judging = ledgerOf(
      [item("L1", { status: "in_progress", evidence: "suite passed", judging: true })],
      true,
    );
    const failed = updatedItem(
      plan(record("fail", judging, "The test file does not exist."), judging),
    );
    assert.equal(failed?.status, "in_progress");
    assert.notProperty(failed ?? {}, "judging");
    assert.equal(failed?.verdict?.notes, "The test file does not exist.");
  });

  it("hands the item back with the reason when the judge produced no verdict", () => {
    const judging = ledgerOf(
      [item("L1", { status: "in_progress", evidence: "suite passed", judging: true })],
      true,
    );
    const abandon: LedgerCommand = {
      type: "ledger.item.judgement.abandon",
      commandId,
      threadId,
      ledgerId,
      itemId: id("L1"),
      reason: "The judge ended failed.",
    };
    const handedBack = updatedItem(plan(abandon, judging));
    assert.equal(handedBack?.status, "in_progress");
    assert.notProperty(handedBack ?? {}, "judging");
    assert.equal(handedBack?.judgeError, "The judge ended failed.");
    assert.isNull(handedBack?.verdict ?? null);
    // Nothing to abandon once a verdict has landed.
    const noop = plan(abandon, judged);
    assert.deepEqual(Result.isSuccess(noop) ? noop.success : "failed", []);
  });

  it("still only records the verdict for an item nobody asked to close", () => {
    const recorded = updatedItem(plan(record("pass", judged, "", null), judged));
    assert.equal(recorded?.status, "in_progress");
    assert.equal(recorded?.verdict?.outcome, "pass");
  });

  it("does not judge on a ledger without a judge", () => {
    const plain = ledgerOf([item("L1", { status: "in_progress", evidence: "suite passed" })]);
    const closed = updatedItem(plan(update("L1", { status: "closed" }), plain));
    assert.equal(closed?.status, "closed");
    assert.notProperty(closed ?? {}, "judging");
  });

  it("checks blockers before a judgement starts", () => {
    const blocked = ledgerOf(
      [item("L0"), item("L1", { status: "in_progress", evidence: "x", blockedBy: [id("L0")] })],
      true,
    );
    assert.include(
      failureOf(plan(update("L1", { status: "closed", createdBy: "agent" }), blocked)),
      "L0",
    );
  });
});

describe("deferring work others wait on", () => {
  const ledger = ledgerOf([
    item("L1"),
    item("L2", { blockedBy: [id("L1")] }),
    item("L3", { status: "closed", evidence: "ok", closedAt: earlier, blockedBy: [id("L1")] }),
  ]);

  it("refuses to defer an item unfinished work depends on, naming the dependents", () => {
    const refused = failureOf(
      plan(update("L1", { status: "deferred", deferReason: "later" }), ledger),
    );
    assert.include(refused, "L2");
    assert.notInclude(refused, "L3");
    // Once its dependents are deferred too it can go.
    const dependentsDeferred = ledgerOf([
      item("L1"),
      item("L2", { blockedBy: [id("L1")], status: "deferred", deferReason: "later" }),
    ]);
    assert.equal(
      updatedItem(
        plan(update("L1", { status: "deferred", deferReason: "later" }), dependentsDeferred),
      )?.status,
      "deferred",
    );
  });

  it("refuses new work that waits on a deferred item", () => {
    const withDeferred = ledgerOf([item("D", { status: "deferred", deferReason: "later" })]);
    assert.include(
      failureOf(plan(add([draft("N", { blockedBy: ["D"] })]), withDeferred)),
      "deferred",
    );
  });
});

describe("what the agent may set aside on a judged ledger", () => {
  const judgedLedger = ledgerOf(
    [item("S", { status: "in_progress", evidence: "half" }), item("N")],
    true,
  );
  const asAgent = (name: string, fields: UpdateFields) =>
    plan(update(name, { ...fields, createdBy: "agent" }), judgedLedger);

  it("refuses the agent dropping, deferring or un-starting work it started", () => {
    for (const fields of [
      { status: "dropped", dropReason: "too hard" },
      { status: "deferred", deferReason: "later" },
      { status: "open" },
    ] as const) {
      assert.include(failureOf(asAgent("S", fields)), "ask the user", fields.status);
    }
  });

  it("lets the agent defer work it never started, and the user set aside anything", () => {
    assert.equal(
      updatedItem(asAgent("N", { status: "deferred", deferReason: "later" }))?.status,
      "deferred",
    );
    assert.equal(
      updatedItem(plan(update("S", { status: "dropped", dropReason: "not needed" }), judgedLedger))
        ?.status,
      "dropped",
    );
  });

  it("does not restrict the agent on a ledger without a judge", () => {
    const plain = ledgerOf([item("S", { status: "in_progress", evidence: "half" })]);
    const dropped = plan(
      update("S", { status: "dropped", dropReason: "moot", createdBy: "agent" }),
      plain,
    );
    assert.equal(updatedItem(dropped)?.status, "dropped");
  });
});

describe("judge start bookkeeping", () => {
  const judgingAt = DateTime.makeUnsafe("2026-01-01T00:04:00.000Z");
  const judging = ledgerOf(
    [item("L1", { status: "in_progress", evidence: "ok", judging: true, updatedAt: judgingAt })],
    true,
  );
  const started = (requestedAt: DateTime.Utc): LedgerCommand => ({
    type: "ledger.item.judgement.started",
    commandId,
    threadId,
    ledgerId,
    itemId: id("L1"),
    requestedAt,
    taskId: NodeId.make("task:judge"),
  });

  it("records the judge task for the request that started it, and only that one", () => {
    const recorded = updatedItem(plan(started(judgingAt), judging));
    assert.equal(recorded?.judgeTaskId, "task:judge");
    // The request stamp stays, since it keys the judge's effect and delegation.
    assert.equal(DateTime.toEpochMillis(recorded!.updatedAt), DateTime.toEpochMillis(judgingAt));
    const stale = plan(started(earlier), judging);
    assert.deepEqual(Result.isSuccess(stale) ? stale.success : "failed", []);
  });

  it("forgets the task once a verdict settles the item", () => {
    const withTask = ledgerOf(
      [
        item("L1", {
          status: "in_progress",
          evidence: "ok",
          judging: true,
          judgeTaskId: NodeId.make("task:judge"),
        }),
      ],
      true,
    );
    const settled = updatedItem(
      plan(
        {
          type: "ledger.item.verdict.record",
          commandId,
          threadId,
          ledgerId,
          itemId: id("L1"),
          verdict: {
            outcome: "fail",
            judge: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
            notes: "no",
            at: now,
          },
          judgingRequestedAt: earlier,
        },
        withTask,
      ),
    );
    assert.notProperty(settled ?? {}, "judgeTaskId");
  });

  it("emits one start effect per close request, keyed by ledger, item and request stamp", () => {
    const ledger = ledgerOf([item("L1", { status: "in_progress", evidence: "ok" })], true);
    const command = update("L1", { status: "closed", createdBy: "agent" });
    const planned = plan(command, ledger);
    const effects = ledgerJudgeEffects(
      command,
      ledger,
      Result.isSuccess(planned) ? planned.success : [],
    );
    assert.deepEqual(
      effects.map((effect) => effect.id),
      [`effect:ledger-judge:${ledgerId}:L1:${DateTime.formatIso(now)}`],
    );
    // A repeat while judging plans nothing, so it starts nothing.
    const judgingLedger = ledgerOf([updatedItem(planned)!], true);
    const repeat = plan(command, judgingLedger);
    assert.deepEqual(
      ledgerJudgeEffects(command, judgingLedger, Result.isSuccess(repeat) ? repeat.success : []),
      [],
    );
  });
});

describe("tasks linked to an item", () => {
  const task = (name: string) => ({
    taskId: NodeId.make(`task:${name}`),
    childThreadId: ThreadId.make(`thread:child:${name}`),
    role: "worker",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  });
  const link = (name: string, taskName: string): LedgerCommand => ({
    type: "ledger.item.task.link",
    commandId,
    threadId,
    ledgerId,
    itemId: id(name),
    task: task(taskName),
  });

  it("appends the task to the item, stamped with the link time, in link order", () => {
    const first = updatedItem(plan(link("L1", "explore"), ledgerOf([item("L1")])));
    assert.deepEqual(first?.tasks, [{ ...task("explore"), createdAt: now }]);
    const second = updatedItem(plan(link("L1", "build"), ledgerOf([first!])));
    assert.deepEqual(
      second?.tasks?.map(({ taskId }) => taskId),
      [NodeId.make("task:explore"), NodeId.make("task:build")],
    );
  });

  it("keeps the item's own stamp, so a pending close request stays the current one", () => {
    const judgingAt = DateTime.makeUnsafe("2026-01-01T00:04:00.000Z");
    const judging = item("L1", {
      status: "in_progress",
      evidence: "ok",
      judging: true,
      updatedAt: judgingAt,
    });
    const linked = updatedItem(plan(link("L1", "fix"), ledgerOf([judging], true)));
    assert.equal(linked?.tasks?.length, 1);
    assert.isTrue(linked?.judging);
    assert.equal(DateTime.toEpochMillis(linked!.updatedAt), DateTime.toEpochMillis(judgingAt));
  });

  it("treats linking the same task again as already in effect, even once the item closed", () => {
    const linked = updatedItem(plan(link("L1", "build"), ledgerOf([item("L1")])))!;
    const retried = plan(link("L1", "build"), ledgerOf([linked]));
    assert.deepEqual(Result.isSuccess(retried) ? retried.success : "failed", []);
    const closed = { ...linked, status: "closed" as const, evidence: "ok", closedAt: now };
    const late = plan(link("L1", "build"), ledgerOf([closed]));
    assert.deepEqual(Result.isSuccess(late) ? late.success : "failed", []);
  });

  it("refuses an unknown, closed or dropped item, and a closed ledger", () => {
    const ledger = ledgerOf([
      item("L1", { status: "closed", evidence: "ok", closedAt: now }),
      item("L2", { status: "dropped", dropReason: "not needed" }),
      item("L3", { status: "deferred", deferReason: "later" }),
    ]);
    assert.include(failureOf(plan(link("L9", "x"), ledger)), "Unknown item L9");
    assert.include(failureOf(plan(link("L1", "x"), ledger)), "L1 is closed");
    assert.include(failureOf(plan(link("L2", "x"), ledger)), "L2 is dropped");
    // Exploring a deferred item is still work on it.
    assert.equal(updatedItem(plan(link("L3", "x"), ledger))?.tasks?.length, 1);
    const closedLedger = { ...ledgerOf([item("L4")]), closedAt: now };
    assert.include(failureOf(plan(link("L4", "x"), closedLedger)), "is closed");
  });

  it("names what is wrong in the words delegate_task reports before any work starts", () => {
    const ledger = ledgerOf([item("L1", { status: "dropped", dropReason: "no" }), item("L2")]);
    const problem = (target: Ledger | undefined, name: string) =>
      ledgerTaskLinkProblem(target, id(name)) ?? "";
    assert.include(problem(undefined, "L1"), "has no ledger");
    assert.include(problem({ ...ledger, closedAt: now }, "L2"), "is closed");
    assert.include(problem(ledger, "L7"), "Unknown ledger item L7");
    assert.include(problem(ledger, "L1"), "L1 is dropped");
    assert.isUndefined(ledgerTaskLinkProblem(ledger, id("L2")));
  });

  it("still decodes an item stored before tasks were linked", () => {
    const stored = decodeLedgerJson({
      id: ledgerId,
      threadId,
      title: "Older",
      startState: "",
      checkpoints: [],
      winConditions: [],
      items: [
        {
          id: "L1",
          title: "Older item",
          acceptance: "works",
          status: "open",
          evidence: null,
          dropReason: null,
          verdict: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          closedAt: null,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: null,
    });
    assert.isUndefined(stored.items[0]?.tasks);
    const linked = updatedItem(plan(link("L1", "build"), stored));
    const encoded = encodeLedgerJson({ ...stored, items: [linked!] });
    assert.deepEqual(decodeLedgerJson(encoded).items[0]?.tasks, [
      { ...task("build"), createdAt: now },
    ]);
  });
});
