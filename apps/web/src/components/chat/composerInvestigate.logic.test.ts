import { describe, expect, it } from "vite-plus/test";

import {
  buildInvestigateStart,
  EMPTY_INVESTIGATE_DRAFT,
  type InvestigateSendTarget,
  planInvestigateSend,
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
const thread: InvestigateSendTarget = { kind: "thread" };
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
      expect(send(mode, thread)).toEqual({ kind: "turn" });
    }
  });

  it("starts an investigation on a thread after saving the thread's settings", () => {
    expect(send("investigate", thread)).toEqual({
      kind: "investigation",
      steps: [{ type: "persist-thread-settings" }, { type: "start-investigation", start }],
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
    ).toEqual({
      kind: "refused",
      problem:
        "Investigate needs a loadout with a judge role to refute each approach, and Solo has none. Pick one in the loadout picker.",
    });
    expect(send("investigate", draft({ newWorktree: true }))).toMatchObject({ kind: "refused" });
    expect(send("investigate", draft(), { hasAttachments: true })).toMatchObject({
      kind: "refused",
    });
    expect(send("investigate", draft(), { prompt: " " })).toMatchObject({ kind: "refused" });
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
