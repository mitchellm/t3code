import { describe, expect, it } from "vite-plus/test";

import {
  buildInvestigateStart,
  clampParallelApproaches,
  EMPTY_INVESTIGATE_DRAFT,
  investigateHint,
  type InvestigateSendTarget,
  planInvestigateSend,
  runInvestigateSteps,
} from "./composerInvestigate.logic";

const fields = { ...EMPTY_INVESTIGATE_DRAFT, solvedWhen: "A failing test passes." };
const goal = "Why does sync drop rows?";
const start = {
  goal,
  solvedWhen: "A failing test passes.",
  budget: { minutes: 30 },
  parallelApproaches: EMPTY_INVESTIGATE_DRAFT.parallelApproaches,
};
const judged = { id: "judged", reason: null, setBy: "user" } as const;
const noJudge =
  "Investigate needs a loadout with a judge role to refute each approach, and Solo has none. Pick one in the loadout picker.";
const thread = (
  patch: Partial<Extract<InvestigateSendTarget, { kind: "thread" }>> = {},
): InvestigateSendTarget => ({ kind: "thread", loadoutName: "Judged", hasJudge: true, ...patch });
const draft = (
  patch: Partial<Extract<InvestigateSendTarget, { kind: "draft" }>> = {},
): InvestigateSendTarget => ({
  kind: "draft",
  loadout: judged,
  loadoutName: "Judged",
  hasJudge: true,
  newWorktree: false,
  ...patch,
});
const send = (
  mode: "build" | "plan" | "investigate",
  target: InvestigateSendTarget,
  patch: { readonly prompt?: string; readonly hasAttachments?: boolean } = {},
) =>
  planInvestigateSend({
    mode,
    fields: mode === "investigate" ? fields : null,
    prompt: patch.prompt ?? goal,
    hasAttachments: patch.hasAttachments ?? false,
    target,
  });

describe("planInvestigateSend", () => {
  it("leaves Build and Plan to the composer's turn, on a draft and on a thread", () => {
    for (const mode of ["build", "plan"] as const) {
      expect(send(mode, draft())).toEqual({ kind: "turn" });
      expect(send(mode, thread())).toEqual({ kind: "turn" });
    }
  });

  it("starts an investigation on a thread with a judge after saving the thread's settings", () => {
    expect(send("investigate", thread())).toEqual({
      kind: "investigation",
      steps: [{ type: "persist-thread-settings" }, { type: "start-investigation", start }],
    });
  });

  it("refuses a thread whose loadout has no judge, as the server would", () => {
    expect(send("investigate", thread({ loadoutName: "Solo", hasJudge: false }))).toEqual({
      kind: "refused",
      problem: noJudge,
    });
  });

  it("creates a draft's thread under its loadout before starting the investigation", () => {
    expect(send("investigate", draft())).toEqual({
      kind: "investigation",
      steps: [
        { type: "create-thread" },
        { type: "set-loadout", loadout: judged },
        { type: "start-investigation", start },
      ],
    });
  });

  it("refuses a draft before creating anything when nothing could start", () => {
    expect(
      send("investigate", draft({ loadout: null, loadoutName: "Solo", hasJudge: false })),
    ).toEqual({ kind: "refused", problem: noJudge });
    expect(send("investigate", draft({ newWorktree: true }))).toMatchObject({ kind: "refused" });
    expect(send("investigate", draft(), { hasAttachments: true })).toMatchObject({
      kind: "refused",
    });
    expect(send("investigate", draft(), { prompt: " " })).toMatchObject({ kind: "refused" });
  });
});

describe("investigateHint", () => {
  const hint = (prompt: string, target: InvestigateSendTarget) =>
    investigateHint({ fields, prompt, target });

  it("names what Send would refuse before anything is sent, goal first", () => {
    for (const solo of [
      draft({ loadout: null, loadoutName: "Solo", hasJudge: false }),
      thread({ loadoutName: "Solo", hasJudge: false }),
    ]) {
      expect(hint("", solo)).toEqual({
        tone: "warning",
        text: "Write the goal above. Solved when is how the judge checks it.",
      });
      expect(hint(goal, solo)).toEqual({ tone: "warning", text: noJudge });
    }
  });

  it("says what Send does once it can start", () => {
    for (const target of [draft(), thread()]) {
      expect(hint(goal, target)).toEqual({
        tone: "info",
        text: "Send starts it. The budget ends it if nothing passes first.",
      });
    }
  });
});

describe("clampParallelApproaches", () => {
  it("snaps typed values into the range the server runs", () => {
    expect(clampParallelApproaches(10)).toBe(8);
    expect(clampParallelApproaches(0)).toBe(1);
    expect(clampParallelApproaches(Number.NaN)).toBe(EMPTY_INVESTIGATE_DRAFT.parallelApproaches);
    expect(clampParallelApproaches(3.6)).toBe(4);
  });
});

describe("runInvestigateSteps", () => {
  it("holds the composer's send guard until the start settles, and stops at the first failure", async () => {
    type Result =
      | { readonly _tag: "Success" }
      | { readonly _tag: "Failure"; readonly cause: string };
    const inFlight = { current: false };
    const ran: string[] = [];
    let settle: (result: Result) => void = () => {};
    const steps = [{ type: "create-thread" }, { type: "start-investigation", start }] as const;
    const pending = runInvestigateSteps<Result>({
      steps,
      inFlight,
      run: (step) => {
        ran.push(step.type);
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    });

    // A Build send, or a second Investigate, from the same draft is refused meanwhile.
    expect(inFlight.current).toBe(true);
    await expect(
      runInvestigateSteps<Result>({
        steps,
        inFlight,
        run: () => Promise.resolve({ _tag: "Success" }),
      }),
    ).resolves.toEqual({ kind: "busy" });

    settle({ _tag: "Failure", cause: "unknown loadout" });
    await expect(pending).resolves.toEqual({
      kind: "failed",
      result: { _tag: "Failure", cause: "unknown loadout" },
    });
    expect(ran).toEqual(["create-thread"]);
    expect(inFlight.current).toBe(false);
  });
});

describe("buildInvestigateStart", () => {
  it("needs a goal, criteria and at least one budget", () => {
    expect(buildInvestigateStart(EMPTY_INVESTIGATE_DRAFT, "  ")).toMatchObject({ ok: false });
    expect(buildInvestigateStart(EMPTY_INVESTIGATE_DRAFT, "Why does sync drop rows?")).toEqual({
      ok: false,
      problem: "Say when the investigation is solved.",
    });
    expect(
      buildInvestigateStart(
        { ...EMPTY_INVESTIGATE_DRAFT, solvedWhen: "A test reproduces it.", minutes: "" },
        "Why?",
      ),
    ).toEqual({ ok: false, problem: "Set a budget in minutes, dollars, or both." });
  });

  it("keeps the criteria verbatim apart from trimming and clamps the approaches", () => {
    expect(
      buildInvestigateStart(
        {
          solvedWhen: "  A failing test passes with the fix.\n",
          minutes: "45",
          usd: "2.50",
          parallelApproaches: 12,
        },
        "Why does sync drop rows?",
      ),
    ).toEqual({
      ok: true,
      goal: "Why does sync drop rows?",
      solvedWhen: "A failing test passes with the fix.",
      budget: { minutes: 45, usd: 2.5 },
      parallelApproaches: 8,
    });
  });

  it("refuses a fractional minute budget", () => {
    expect(
      buildInvestigateStart(
        { ...EMPTY_INVESTIGATE_DRAFT, solvedWhen: "done", minutes: "1.5" },
        "Why?",
      ),
    ).toMatchObject({ ok: false });
  });
});
