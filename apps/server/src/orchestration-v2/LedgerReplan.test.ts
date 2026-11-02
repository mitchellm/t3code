import {
  type Ledger,
  LedgerId,
  type LedgerItem,
  LedgerItemId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { progressMark } from "@t3tools/shared/taskLedger";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  decideLedgerFollowUp,
  decideStopHookNudge,
  JUDGED_SET_ASIDE_HINT,
  judgeFailures,
  LEDGER_JUDGE_FAILURE_REPLAN_THRESHOLD,
  ledgerReplanText,
  ledgerSetAsideHintText,
} from "./LedgerReplan.ts";

const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 26));

const item = (name: string, overrides: Partial<LedgerItem> = {}): LedgerItem => ({
  id: LedgerItemId.make(`item:${name}`),
  title: `Item ${name}`,
  acceptance: `${name} works`,
  status: "open",
  evidence: null,
  dropReason: null,
  verdict: null,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
  ...overrides,
});

const verdict = (outcome: "pass" | "fail") => ({
  outcome,
  judge: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  notes: `${outcome}: the parser still drops trailing commas`,
  at,
});

const failedJudge = (name: string, times: number) =>
  item(name, { status: "in_progress", verdict: verdict("fail"), judgements: times });

const ledgerOf = (...items: ReadonlyArray<LedgerItem>): Ledger => ({
  id: LedgerId.make("ledger:replan"),
  threadId: ThreadId.make("thread:replan"),
  title: "Ship the parser",
  startState: "",
  checkpoints: [],
  winConditions: [],
  items,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
});

type Message = Parameters<typeof decideLedgerFollowUp>[0]["messages"][number];
const userMessage: Message = { role: "user", createdBy: "user", creationSource: "web" };
const followUp = (
  round: number,
  ledger: Ledger,
  replan?: { readonly reason: "stalled" | "judge"; readonly itemIds: ReadonlyArray<string> },
): Message => ({
  role: "user",
  createdBy: "agent",
  creationSource: "server",
  notification: {
    source: {
      kind: "ledger_continue",
      round,
      items: ledger.items.map(progressMark),
      ...(replan === undefined
        ? {}
        : {
            replan: {
              reason: replan.reason,
              itemIds: replan.itemIds.map((id) => LedgerItemId.make(id)),
            },
          }),
    },
    outcome: "updated",
    summary: "open",
  },
});

describe("follow-ups after the user speaks", () => {
  const parked = ledgerOf(item("a", { status: "in_progress" }));

  it("stay off when the user's turn left the ledger as the last follow-up found it", () => {
    // The stalled streak stopped; the user asked something else and the turn touched no item.
    expect(
      decideLedgerFollowUp({
        ledger: parked,
        messages: [userMessage, followUp(1, parked), followUp(2, parked), userMessage],
      }),
    ).toEqual({ type: "idle" });
  });

  it("restart once the user's turn moved the ledger, or when no follow-up was ever sent", () => {
    const moved = ledgerOf(item("a", { status: "in_progress" }), item("b"));
    expect(
      decideLedgerFollowUp({
        ledger: moved,
        messages: [userMessage, followUp(1, parked), followUp(2, parked), userMessage],
      }),
    ).toMatchObject({ type: "continue", round: 1 });
    expect(decideLedgerFollowUp({ ledger: parked, messages: [userMessage] })).toMatchObject({
      type: "continue",
      round: 1,
    });
  });
});

describe("follow-ups after a stalled replan", () => {
  const before = ledgerOf(
    item("a", { status: "in_progress" }),
    item("b", { status: "in_progress" }),
  );
  const stalledReplan = followUp(2, before, { reason: "stalled", itemIds: ["item:a", "item:b"] });
  const wake: Message = { role: "user", createdBy: "agent", creationSource: "server" };
  const bClosed = ledgerOf(item("a", { status: "in_progress" }), item("b", { status: "closed" }));

  it("stay off when a later wake closes other work and what is left already stalled as it is", () => {
    expect(
      decideLedgerFollowUp({
        ledger: bClosed,
        messages: [userMessage, followUp(1, before), stalledReplan, wake],
      }),
    ).toEqual({ type: "idle" });
  });

  it("continue when the replan's own turn moved the ledger, or an open item is new or changed", () => {
    expect(
      decideLedgerFollowUp({
        ledger: bClosed,
        messages: [userMessage, followUp(1, before), stalledReplan],
      }),
    ).toMatchObject({ type: "continue" });
    const withNew = ledgerOf(
      item("a", { status: "in_progress" }),
      item("b", { status: "closed" }),
      item("c"),
    );
    expect(
      decideLedgerFollowUp({
        ledger: withNew,
        messages: [userMessage, followUp(1, before), stalledReplan, wake],
      }),
    ).toMatchObject({ type: "continue" });
  });
});

describe("judgeFailures", () => {
  it("counts recorded verdicts only while the latest one failed", () => {
    expect(judgeFailures(failedJudge("a", 3))).toBe(3);
    expect(judgeFailures(item("a", { verdict: verdict("pass"), judgements: 3 }))).toBe(0);
    expect(judgeFailures(item("a"))).toBe(0);
  });

  it("counts only failures since the item was last reopened or passed", () => {
    expect(judgeFailures({ ...failedJudge("a", 4), judgementsAtReopen: 3 })).toBe(1);
  });
});

describe("stall replan items", () => {
  it("lists only items the agent can act on, keeping a repeatedly failed item's judge notes", () => {
    const ledger = ledgerOf(
      item("a", { blockedBy: [LedgerItemId.make("item:b")] }),
      failedJudge("b", 3),
      { ...failedJudge("c", 1), judging: true },
    );
    // b already had its judge replan this streak, so this round is the stall's.
    const decision = decideLedgerFollowUp({
      ledger,
      messages: [userMessage, followUp(1, ledger, { reason: "judge", itemIds: ["item:b"] })],
    });
    expect(decision).toEqual({ type: "stuck", reason: "stalled", openIds: expect.any(Array) });

    const stalled = decideLedgerFollowUp({ ledger, messages: [userMessage, followUp(1, ledger)] });
    expect(stalled).toMatchObject({ type: "replan", reason: "stalled", replanItemIds: ["item:b"] });
    if (stalled.type !== "replan") return;
    const text = ledgerReplanText({ ledger, reason: "stalled", items: stalled.replanItems });
    expect(text).toContain("the parser still drops trailing commas");
    expect(text).not.toContain("item:a");
    expect(text).not.toContain("item:c");

    const nudge = decideStopHookNudge({
      ledger,
      open: ledger.items,
      unchangedBlocks: 3,
      limit: 3,
      judgeReplanned: new Set(["item:b"]),
    });
    expect(nudge).toMatchObject({ type: "replan", reason: "stalled", items: [ledger.items[1]] });
  });
});

describe("decideLedgerFollowUp", () => {
  it("replans once when a round made no progress, then stops if the replan changed nothing", () => {
    const ledger = ledgerOf(item("a"), item("b"));
    const stalled = decideLedgerFollowUp({ ledger, messages: [userMessage, followUp(1, ledger)] });
    expect(stalled).toMatchObject({
      type: "replan",
      reason: "stalled",
      round: 2,
      replanItemIds: ["item:a", "item:b"],
    });

    const afterReplan = decideLedgerFollowUp({
      ledger,
      messages: [
        userMessage,
        followUp(1, ledger),
        followUp(2, ledger, { reason: "stalled", itemIds: ["item:a", "item:b"] }),
      ],
    });
    expect(afterReplan).toEqual({
      type: "stuck",
      reason: "stalled",
      openIds: ["item:a", "item:b"],
    });
  });

  it("goes back to plain follow-ups once the replan moved the ledger, and replans a later stall", () => {
    const before = ledgerOf(item("a"), item("b"));
    const replanned = followUp(2, before, { reason: "stalled", itemIds: ["item:a", "item:b"] });
    const moved = ledgerOf(item("a", { status: "deferred", deferReason: "later" }), item("b"));
    expect(
      decideLedgerFollowUp({
        ledger: moved,
        messages: [userMessage, followUp(1, before), replanned],
      }),
    ).toMatchObject({ type: "continue", round: 1 });

    // A new stall after progress is a new episode and earns its own replan; the deferred item
    // restarted the count, so only the round sent after it counts.
    expect(
      decideLedgerFollowUp({
        ledger: moved,
        messages: [userMessage, followUp(1, before), replanned, followUp(1, moved)],
      }),
    ).toMatchObject({ type: "replan", reason: "stalled", round: 2 });
  });

  it(`replans an item that failed the judge ${LEDGER_JUDGE_FAILURE_REPLAN_THRESHOLD} times, once`, () => {
    const twice = ledgerOf(failedJudge("a", 2), item("b"));
    expect(decideLedgerFollowUp({ ledger: twice, messages: [userMessage] })).toMatchObject({
      type: "continue",
    });

    const thrice = ledgerOf(failedJudge("a", 3), item("b"));
    const decision = decideLedgerFollowUp({
      ledger: thrice,
      messages: [userMessage, followUp(1, twice)],
    });
    expect(decision).toMatchObject({
      type: "replan",
      reason: "judge",
      round: 2,
      replanItemIds: ["item:a"],
    });

    const fourTimes = ledgerOf(failedJudge("a", 4), item("b"));
    expect(
      decideLedgerFollowUp({
        ledger: fourTimes,
        messages: [
          userMessage,
          followUp(1, twice),
          followUp(2, thrice, { reason: "judge", itemIds: ["item:a"] }),
        ],
      }),
    ).toMatchObject({ type: "continue", round: 3 });
  });

  it("leaves an item alone while the judge is still working on it", () => {
    const judging = ledgerOf({ ...failedJudge("a", 3), judging: true });
    expect(decideLedgerFollowUp({ ledger: judging, messages: [userMessage] })).toMatchObject({
      type: "continue",
    });
  });
});

describe("decideStopHookNudge", () => {
  const open = [item("a"), failedJudge("b", 3)];
  const ledger = ledgerOf(...open);
  const limit = 3;

  it("blocks, then replans at the no-progress limit, then allows", () => {
    const none = new Set<string>(["item:b"]);
    const nudge = (unchangedBlocks: number) =>
      decideStopHookNudge({ ledger, open, unchangedBlocks, limit, judgeReplanned: none });
    expect(nudge(0)).toEqual({ type: "block" });
    expect(nudge(limit)).toMatchObject({ type: "replan", reason: "stalled", items: open });
    expect(nudge(limit + 1)).toEqual({ type: "allow" });
  });

  it("replans an item the judge failed repeatedly, unless already replanned this prompt", () => {
    expect(
      decideStopHookNudge({ ledger, open, unchangedBlocks: 0, limit, judgeReplanned: new Set() }),
    ).toMatchObject({ type: "replan", reason: "judge", items: [open[1]] });
  });
});

describe("the set-aside hint on an idle judged ledger", () => {
  const judged = (...items: ReadonlyArray<LedgerItem>): Ledger => ({
    ...ledgerOf(...items),
    requiresJudge: true,
  });
  const hintMessage = (
    ledger: Ledger,
    sent: ReadonlyArray<{ readonly itemId: string; readonly judgements: number }>,
  ): Message => ({
    role: "user",
    createdBy: "agent",
    creationSource: "server",
    notification: {
      source: {
        kind: "ledger_continue",
        round: 1,
        items: ledger.items.map(progressMark),
        setAsideHint: sent.map(({ itemId, judgements }) => ({
          itemId: LedgerItemId.make(itemId),
          judgements,
        })),
      },
      outcome: "updated",
      summary: "hint",
    },
  });

  // The user spoke and their turn left the ledger as the last round found it: idle.
  const idleAfterUser = (ledger: Ledger, ...between: ReadonlyArray<Message>): Array<Message> => [
    userMessage,
    followUp(1, ledger),
    ...between,
    userMessage,
  ];

  it("is sent when the ledger would otherwise go idle on a judge-failed item", () => {
    const ledger = judged(failedJudge("a", 1), item("b", { status: "closed" }));
    expect(decideLedgerFollowUp({ ledger, messages: idleAfterUser(ledger) })).toMatchObject({
      type: "hint",
      hintItems: [expect.objectContaining({ id: "item:a" })],
    });
  });

  it("is sent once per fail: a restart or a second evaluation finds it already sent", () => {
    const ledger = judged(failedJudge("a", 1));
    const sent = hintMessage(ledger, [{ itemId: "item:a", judgements: 1 }]);
    expect(decideLedgerFollowUp({ ledger, messages: idleAfterUser(ledger, sent) })).toEqual({
      type: "idle",
    });
  });

  it("is re-armed by a new failed verdict on the item", () => {
    const first = judged(failedJudge("a", 1));
    const sent = hintMessage(first, [{ itemId: "item:a", judgements: 1 }]);
    const second = judged(failedJudge("a", 2));
    expect(
      decideLedgerFollowUp({ ledger: second, messages: idleAfterUser(second, sent) }),
    ).toMatchObject({
      type: "hint",
      hintItems: [expect.objectContaining({ id: "item:a", judgements: 2 })],
    });
  });

  it("is not sent without a judge gate, a failed latest verdict, or while a judge is working", () => {
    const solo = ledgerOf(failedJudge("a", 1));
    expect(decideLedgerFollowUp({ ledger: solo, messages: idleAfterUser(solo) })).toEqual({
      type: "idle",
    });
    const passed = judged(item("a", { verdict: verdict("pass"), judgements: 1 }));
    expect(decideLedgerFollowUp({ ledger: passed, messages: idleAfterUser(passed) })).toEqual({
      type: "idle",
    });
    const judging = judged({ ...failedJudge("a", 1), judging: true });
    expect(decideLedgerFollowUp({ ledger: judging, messages: idleAfterUser(judging) })).toEqual({
      type: "idle",
    });
  });

  it("stays quiet after the user cancelled a follow-up", () => {
    const ledger = judged(failedJudge("a", 1));
    const cancelled: Message = { ...followUp(1, ledger), runId: "run:cancelled" as never };
    expect(
      decideLedgerFollowUp({
        ledger,
        messages: [userMessage, cancelled, userMessage],
        cancelledRunIds: new Set(["run:cancelled"]),
      }),
    ).toEqual({ type: "idle" });
  });

  it("does not count toward the cap or stand as the round a later one is compared with", () => {
    const ledger = judged(failedJudge("a", 1));
    const sent = hintMessage(ledger, [{ itemId: "item:a", judgements: 1 }]);
    const moved = judged(failedJudge("a", 1), item("b"));
    expect(
      decideLedgerFollowUp({ ledger: moved, messages: [userMessage, followUp(1, ledger), sent] }),
    ).toMatchObject({ type: "continue", round: 2 });
  });

  it("tells the agent it can set the item aside itself, with the judge's notes", () => {
    const failed = failedJudge("a", 1);
    const text = ledgerSetAsideHintText({ ledger: judged(failed), items: [failed] });
    expect(text).toContain(JUDGED_SET_ASIDE_HINT);
    expect(text).toContain("item:a");
    expect(text).toContain("the parser still drops trailing commas");
    expect(text).toContain("do not ask the user to drop or defer it");
  });
});
