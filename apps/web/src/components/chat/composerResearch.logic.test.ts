import { describe, expect, it } from "vite-plus/test";

import { parseResearchSources, researchAvailable, researchPrompt } from "./composerResearch.logic";

describe("research composer", () => {
  it("starts the message with the research command so Claude runs the workflow", () => {
    expect(researchPrompt("  What changed in saves?  ", "~/exports/u80\n\n- docs/saves.md\n")).toBe(
      "/t3:research What changed in saves?\n\nSources:\n- ~/exports/u80\n- docs/saves.md",
    );
  });

  it("says to search the web when no sources are named", () => {
    expect(researchPrompt("Who ships faster?", "  \n")).toBe(
      "/t3:research Who ships faster?\n\nNo sources named: search the web.",
    );
  });

  it("leaves a message that already runs the command alone", () => {
    expect(researchPrompt("/t3:research Q use a.md", "b.md")).toBe("/t3:research Q use a.md");
  });

  it("drops pasted bullets and numbering from source lines", () => {
    expect(parseResearchSources("1. a.md\n* b.md\n• thread:abc\n  c/  ")).toEqual([
      "a.md",
      "b.md",
      "thread:abc",
      "c/",
    ]);
  });

  it("is offered only where the provider reports the workflow", () => {
    expect(researchAvailable([{ name: "deep-research" }, { name: "t3:research" }])).toBe(true);
    expect(researchAvailable([{ name: "deep-research" }])).toBe(false);
  });
});
