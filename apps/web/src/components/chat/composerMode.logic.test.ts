import { describe, expect, it } from "vite-plus/test";

import { composerModeChange, composerModeOptions, resolveComposerMode } from "./composerMode.logic";

describe("composer mode", () => {
  it("reads Plan from the interaction mode, Investigate from its open fields, Build otherwise", () => {
    expect(resolveComposerMode({ interactionMode: "default", investigating: false })).toBe("build");
    expect(resolveComposerMode({ interactionMode: "default", investigating: true })).toBe(
      "investigate",
    );
    // Plan changes nothing, so it outranks fields an investigation would act on.
    expect(resolveComposerMode({ interactionMode: "plan", investigating: true })).toBe("plan");
  });

  it("switches through the existing plan toggle and the Investigate fields", () => {
    const build = { interactionMode: "default", investigating: false } as const;
    const plan = { interactionMode: "plan", investigating: false } as const;
    const investigate = { interactionMode: "default", investigating: true } as const;

    expect(composerModeChange(build, "build")).toBeNull();
    expect(composerModeChange(build, "plan")).toEqual({
      toggleInteractionMode: true,
      investigating: false,
    });
    expect(composerModeChange(plan, "investigate")).toEqual({
      toggleInteractionMode: true,
      investigating: true,
    });
    expect(composerModeChange(investigate, "build")).toEqual({
      toggleInteractionMode: false,
      investigating: false,
    });
    expect(composerModeChange(investigate, "plan")).toEqual({
      toggleInteractionMode: true,
      investigating: false,
    });
  });

  it("offers only the modes this composer can use, and no picker for Build alone", () => {
    expect(
      composerModeOptions({ planAvailable: true, investigateAvailable: true })?.map(
        (option) => option.id,
      ),
    ).toEqual(["build", "plan", "investigate"]);
    expect(
      composerModeOptions({ planAvailable: false, investigateAvailable: true })?.map(
        (option) => option.id,
      ),
    ).toEqual(["build", "investigate"]);
    expect(composerModeOptions({ planAvailable: false, investigateAvailable: false })).toBeNull();
  });
});
