// Fork: which build actions a thread offers. Shared so a client hides exactly what the server
// refuses.
import type { BuildModeAction } from "@t3tools/contracts";

export interface BuildModeContext {
  /** An active proposed plan, or an open ledger on a thread still in plan mode. */
  readonly hasWork: boolean;
  /** See providerSupportsCompaction. */
  readonly compactSupported: boolean;
  /** The thread's loadout assigns a judge role. */
  readonly judgeConfigured: boolean;
}

/** Null when the action is offered, else why not. */
export type BuildModeAvailability = Record<BuildModeAction, string | null>;

/**
 * The same test the composer's manual Compact control uses: a provider can compact on request
 * exactly when its snapshot advertises a `compact` command, which T3 sends as a `/compact` turn.
 */
export const providerSupportsCompaction = (
  slashCommands: ReadonlyArray<{ readonly name: string }>,
): boolean => slashCommands.some((command) => command.name === "compact");

export function buildModeAvailability(context: BuildModeContext): BuildModeAvailability {
  const nothing = "There is no proposed plan or planning ledger to build.";
  if (!context.hasWork) {
    return { build: nothing, compact_and_build: nothing, reset_and_build: nothing, audit: nothing };
  }
  return {
    build: null,
    compact_and_build: context.compactSupported
      ? null
      : "This provider cannot compact its context on request.",
    reset_and_build: null,
    audit: context.judgeConfigured ? null : "The thread's loadout has no judge role.",
  };
}
