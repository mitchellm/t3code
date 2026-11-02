import { type Ledger, LedgerId, type LedgerItem, LedgerItemId, ThreadId } from "@t3tools/contracts";
import type { NodeId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { judgeVerdictWakesPlanner } from "./LedgerJudgeWake.ts";

const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 2));
const taskId = "task:judge" as NodeId;

const PASS =
  "C1: PASS - ran `vp test run a.test.ts` myself: 3 passed.\nTests: vp test run a.test.ts -> 3 passed\nVERDICT: PASS";
const FAIL = "C1: FAIL - the empty-input case still throws.\nVERDICT: FAIL";

const item = (name: string, overrides: Partial<LedgerItem> = {}): LedgerItem => ({
  id: LedgerItemId.make(`item:${name}`),
  title: `Item ${name}`,
  acceptance: `${name} works`,
  status: "in_progress",
  evidence: "tests pass",
  dropReason: null,
  verdict: null,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
  ...overrides,
});

const judging = (name = "a", overrides: Partial<LedgerItem> = {}) =>
  item(name, { judging: true, judgeTaskId: taskId, ...overrides });

const ledgerOf = (...items: ReadonlyArray<LedgerItem>): Ledger => ({
  id: LedgerId.make("ledger:wake"),
  threadId: ThreadId.make("thread:wake"),
  title: "Ship it",
  startState: "",
  checkpoints: [],
  winConditions: [],
  items,
  requiresJudge: true,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
});

const wakes = (ledger: Ledger | undefined, answer: string | null, plannerBusy: boolean) =>
  judgeVerdictWakesPlanner({ ledger, taskId, answer, plannerBusy });

describe("whether a judge verdict wakes the planner", () => {
  it("always wakes for a failed verdict, busy planner or not", () => {
    const ledger = ledgerOf(judging(), item("b"));
    expect(wakes(ledger, FAIL, true)).toBe(true);
    expect(wakes(ledger, FAIL, false)).toBe(true);
  });

  it("wakes for a pass that finishes the ledger, so the final report still happens", () => {
    const ledger = ledgerOf(judging(), item("b", { status: "closed" }));
    expect(wakes(ledger, PASS, true)).toBe(true);
    expect(wakes(ledger, PASS, false)).toBe(true);
  });

  it("wakes for a pass that unblocks an item or lets a parent close", () => {
    const blocked = ledgerOf(judging(), item("b", { blockedBy: [LedgerItemId.make("item:a")] }));
    expect(wakes(blocked, PASS, true)).toBe(true);
    const child = ledgerOf(
      judging("a", { parentItemId: LedgerItemId.make("item:p") }),
      item("p"),
      item("c"),
    );
    expect(wakes(child, PASS, true)).toBe(true);
  });

  it("records a mid-ledger pass without a turn while the planner is busy", () => {
    const ledger = ledgerOf(judging(), item("b"), item("c", { status: "closed" }));
    expect(wakes(ledger, PASS, true)).toBe(false);
  });

  it("wakes an idle planner that still has an item it can act on, and not one with nothing to do", () => {
    expect(wakes(ledgerOf(judging(), item("b")), PASS, false)).toBe(true);
    // The only other open item is itself being judged: nothing for the planner to act on.
    const waiting = ledgerOf(judging(), judging("b", { judgeTaskId: "task:other" as NodeId }));
    expect(wakes(waiting, PASS, false)).toBe(false);
  });

  it("wakes as before when it cannot place the verdict", () => {
    const ledger = ledgerOf(judging(), item("b"));
    expect(wakes(undefined, PASS, true)).toBe(true);
    // No item is judging for this task (a judge that ended before its task was recorded).
    expect(
      judgeVerdictWakesPlanner({
        ledger,
        taskId: "task:unknown" as NodeId,
        answer: PASS,
        plannerBusy: true,
      }),
    ).toBe(true);
    // A final PASS line without the per-criterion proof is recorded as a failure.
    expect(wakes(ledger, "VERDICT: PASS", true)).toBe(true);
    expect(wakes(ledger, null, true)).toBe(true);
  });
});
