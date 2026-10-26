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
  judgeFailures,
  LEDGER_JUDGE_FAILURE_REPLAN_THRESHOLD,
  ledgerReplanText,
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
    ).toMatchObject({ type: "continue", round: 3 });

    // A new stall after progress is a new episode and earns its own replan.
    expect(
      decideLedgerFollowUp({
        ledger: moved,
        messages: [userMessage, followUp(1, before), replanned, followUp(3, moved)],
      }),
    ).toMatchObject({ type: "replan", reason: "stalled", round: 4 });
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
