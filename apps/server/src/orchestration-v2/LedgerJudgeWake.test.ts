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

  it("does not wake for a passed ask check that finishes the ledger, since the agent reported when it closed", () => {
    const checked: Ledger = { ...ledgerOf(judging()), requiresJudge: false, askCheck: true };
    const pass =
      "C1: PASS - looked at the forwarded path and the CLI.\nC2: PASS - nothing else was asked; read the message again.\nVERDICT: PASS";
    expect(wakes(checked, pass, false)).toBe(false);
    expect(wakes(checked, pass, true)).toBe(false);
    expect(
      wakes(checked, "C1: FAIL - the forwarded wait still runs 10 minutes.\nVERDICT: FAIL", false),
    ).toBe(true);
    // A pass that leaves other work open still follows the usual rules.
    const more: Ledger = { ...checked, items: [...checked.items, item("b", { status: "open" })] };
    expect(wakes(more, pass, false)).toBe(true);
  });

  describe("under the v2 ask check policy", () => {
    const v2 = (fails: number): Ledger => ({
      ...ledgerOf(judging()),
      requiresJudge: false,
      askCheck: true,
      askCheckPolicy: "v2",
      ...(fails === 0 ? {} : { askCheckFails: fails }),
    });
    const pass =
      "C1: PASS - looked at the forwarded path and the CLI.\nC2: PASS - nothing else was asked; read the message again.\nVERDICT: PASS";

    it("wakes for the first failed check as before, and leaves the second and third to the server's own wake", () => {
      // The server records the second and later failures and wakes the thread itself, with the
      // text of the hand-over or the stop, so the completion wake would be a second turn.
      expect(wakes(v2(0), FAIL, false)).toBe(true);
      expect(wakes(v2(1), FAIL, false)).toBe(false);
      expect(wakes(v2(1), FAIL, true)).toBe(false);
      expect(wakes(v2(2), FAIL, false)).toBe(false);
      // A v1 ledger keeps waking for every failed check.
      const { askCheckPolicy: _dropped, ...v1 } = v2(2);
      expect(wakes(v1, FAIL, false)).toBe(true);
    });

    it("still wakes nobody for a passed check that finishes the ledger, however many failed before", () => {
      expect(wakes(v2(0), pass, false)).toBe(false);
      expect(wakes(v2(2), pass, false)).toBe(false);
      expect(wakes(v2(2), pass, true)).toBe(false);
    });

    it("wakes for an answer that cannot be placed as a failure it recorded itself", () => {
      // No item is judging for this task, so the server did not record anything to wake on.
      expect(
        judgeVerdictWakesPlanner({
          ledger: v2(1),
          taskId: "task:unknown" as NodeId,
          answer: FAIL,
          plannerBusy: false,
        }),
      ).toBe(true);
    });
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
