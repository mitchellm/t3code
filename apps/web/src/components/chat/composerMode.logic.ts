/**
 * Fork: the composer's Mode. Build and Plan are upstream's interaction modes; Investigate is the
 * composer's Investigate fields being open. One picker chooses among them.
 */
import type { ProviderInteractionMode } from "@t3tools/contracts";

export type ComposerMode = "build" | "plan" | "investigate";

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
};

interface ComposerModeState {
  readonly interactionMode: ProviderInteractionMode;
  readonly investigating: boolean;
}

/** Plan outranks open Investigate fields: a turn that may change nothing cannot investigate. */
export function resolveComposerMode(state: ComposerModeState): ComposerMode {
  if (state.interactionMode === "plan") return "plan";
  return state.investigating ? "investigate" : "build";
}

/** Null when only Build is left, so the composer shows no picker. */
export function composerModeOptions(input: {
  readonly planAvailable: boolean;
  readonly investigateAvailable: boolean;
}): ReadonlyArray<ComposerModeOption> | null {
  if (!input.planAvailable && !input.investigateAvailable) return null;
  return [
    OPTIONS.build,
    ...(input.planAvailable ? [OPTIONS.plan] : []),
    ...(input.investigateAvailable ? [OPTIONS.investigate] : []),
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
): { readonly toggleInteractionMode: boolean; readonly investigating: boolean } | null {
  if (resolveComposerMode(state) === next) return null;
  return {
    toggleInteractionMode: (state.interactionMode === "plan") !== (next === "plan"),
    investigating: next === "investigate",
  };
}
