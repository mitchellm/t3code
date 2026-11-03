/**
 * Fork: the composer's Mode. Build and Plan are upstream's interaction modes; Investigate and
 * Research are the composer's Investigate or Research fields being open. One picker chooses
 * among them.
 */
import type { ProviderInteractionMode } from "@t3tools/contracts";

export type ComposerMode = "build" | "plan" | "investigate" | "research";

export interface ComposerModeOption {
  readonly id: ComposerMode;
  readonly label: string;
  readonly description: string;
}

const OPTIONS: Record<ComposerMode, ComposerModeOption> = {
  build: { id: "build", label: "Build", description: "Plans as a ledger, then does the work." },
  plan: { id: "plan", label: "Plan", description: "Plans only. Changes nothing." },
  investigate: {
    id: "investigate",
    label: "Investigate",
    description: "Tries several approaches and keeps the one that survives a refuter.",
  },
  research: {
    id: "research",
    label: "Research",
    description: "Answers a question from the sources you name, with checked citations.",
  },
};

export interface ComposerModeState {
  readonly interactionMode: ProviderInteractionMode;
  readonly investigating: boolean;
  readonly researching?: boolean;
}

/** Plan outranks open fields: a turn that may change nothing cannot investigate or research. */
export function resolveComposerMode(state: ComposerModeState): ComposerMode {
  if (state.interactionMode === "plan") return "plan";
  if (state.investigating) return "investigate";
  return state.researching === true ? "research" : "build";
}

/**
 * The state to keep once Plan is seen. Plan is entered from places that never pass through the
 * picker (the proposed-plan card, the server, Shift+Tab, /plan), so Investigate ends whenever Plan
 * is in force. Research only hides under Plan: its Sources field holds no work in flight.
 */
export function settleComposerMode(state: ComposerModeState): ComposerModeState {
  return state.interactionMode === "plan" && state.investigating
    ? { ...state, investigating: false }
    : state;
}

/** Null when only Build is left, so the composer shows no picker. */
export function composerModeOptions(input: {
  readonly planAvailable: boolean;
  readonly investigateAvailable: boolean;
  readonly researchAvailable?: boolean;
}): ReadonlyArray<ComposerModeOption> | null {
  const researchAvailable = input.researchAvailable === true;
  if (!input.planAvailable && !input.investigateAvailable && !researchAvailable) return null;
  return [
    OPTIONS.build,
    ...(input.planAvailable ? [OPTIONS.plan] : []),
    ...(input.investigateAvailable ? [OPTIONS.investigate] : []),
    ...(researchAvailable ? [OPTIONS.research] : []),
  ];
}

export const composerModeOption = (mode: ComposerMode): ComposerModeOption => OPTIONS[mode];

/**
 * Moving to a mode through upstream's own plan toggle, so its shortcut, slash command and plan
 * card keep working on the same state. Null when the mode is already the current one.
 */
export function composerModeChange(
  state: ComposerModeState,
  next: ComposerMode,
): {
  readonly toggleInteractionMode: boolean;
  readonly investigating: boolean;
  readonly researching: boolean;
} | null {
  if (resolveComposerMode(state) === next) return null;
  return {
    toggleInteractionMode: (state.interactionMode === "plan") !== (next === "plan"),
    investigating: next === "investigate",
    researching: next === "research",
  };
}
