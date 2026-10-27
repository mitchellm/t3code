import { describe, expect, it } from "vite-plus/test";

import { buildInvestigateStart, EMPTY_INVESTIGATE_DRAFT } from "./composerInvestigate.logic";

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
