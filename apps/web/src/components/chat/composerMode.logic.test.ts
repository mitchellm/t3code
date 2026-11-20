import { describe, expect, it } from "vite-plus/test";

import {
  composerModeChange,
  composerModeOption,
  composerModeOptions,
  resolveComposerMode,
  settleComposerMode,
} from "./composerMode.logic";

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
      researching: false,
    });
    expect(composerModeChange(plan, "investigate")).toEqual({
      toggleInteractionMode: true,
      investigating: true,
      researching: false,
    });
    expect(composerModeChange(investigate, "build")).toEqual({
      toggleInteractionMode: false,
      investigating: false,
      researching: false,
    });
    expect(composerModeChange(investigate, "plan")).toEqual({
      toggleInteractionMode: true,
      investigating: false,
      researching: false,
    });
  });

  it("lands in Build when Plan ends, however Plan was entered", () => {
    const investigating = { interactionMode: "default", investigating: true } as const;
    // The proposed-plan card or the server switches to Plan without going through the picker.
    const inPlan = settleComposerMode({ ...investigating, interactionMode: "plan" });
    expect(resolveComposerMode(inPlan)).toBe("plan");
    expect(resolveComposerMode({ ...inPlan, interactionMode: "default" })).toBe("build");
    expect(settleComposerMode(investigating)).toBe(investigating);
  });

  it("offers only the modes this composer can use, and no picker for Build alone", () => {
    expect(
      composerModeOptions({
        planAvailable: true,
        investigateAvailable: true,
        runsOnLedger: false,
      })?.map((option) => option.id),
    ).toEqual(["build", "plan", "investigate"]);
    expect(
      composerModeOptions({
        planAvailable: false,
        investigateAvailable: true,
        runsOnLedger: false,
      })?.map((option) => option.id),
    ).toEqual(["build", "investigate"]);
    expect(
      composerModeOptions({
        planAvailable: false,
        investigateAvailable: false,
        runsOnLedger: false,
      }),
    ).toBeNull();
  });

  it("says Build plans as a ledger only for a thread that runs on the task ledger", () => {
    const buildDescription = (runsOnLedger: boolean) =>
      composerModeOptions({ planAvailable: true, investigateAvailable: false, runsOnLedger })?.find(
        (option) => option.id === "build",
      )?.description;
    expect(buildDescription(true)).toBe("Plans as a ledger, then does the work.");
    expect(buildDescription(false)).toBe("Does the work. Start a ledger with /ledger.");
    expect(composerModeOption("build", true).description).toBe(buildDescription(true));
    expect(composerModeOption("build", false).description).toBe(buildDescription(false));
    // The other modes read the same either way.
    expect(composerModeOption("plan", true)).toEqual(composerModeOption("plan", false));
  });

  it("picks Research in the picker, hidden by Plan and back when Plan ends", () => {
    const research = {
      interactionMode: "default",
      investigating: false,
      researching: true,
    } as const;
    expect(resolveComposerMode(research)).toBe("research");
    expect(composerModeChange(research, "investigate")).toEqual({
      toggleInteractionMode: false,
      investigating: true,
      researching: false,
    });
    expect(
      composerModeChange({ interactionMode: "plan", investigating: false }, "research"),
    ).toEqual({ toggleInteractionMode: true, investigating: false, researching: true });
    const inPlan = settleComposerMode({ ...research, interactionMode: "plan" });
    expect(resolveComposerMode(inPlan)).toBe("plan");
    expect(resolveComposerMode({ ...inPlan, interactionMode: "default" })).toBe("research");
    expect(
      composerModeOptions({
        planAvailable: false,
        investigateAvailable: false,
        researchAvailable: true,
        runsOnLedger: false,
      })?.map((option) => option.id),
    ).toEqual(["build", "research"]);
  });
});
