/**
 * Fork: the loadout a draft will start under. A draft has no thread to hold the choice yet, so it
 * lives here, per draft, until the first send creates the thread with it. Client-only like the
 * Investigate fields: a reload drops it, and the picker then shows Solo again.
 */
import { type Loadout, SOLO_LOADOUT_ID, type ThreadLoadout } from "@t3tools/contracts";
import { resolveLoadout } from "@t3tools/shared/loadouts";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";

const useDraftLoadouts = create<{
  readonly choices: Readonly<Record<string, ThreadLoadout>>;
}>(() => ({ choices: {} }));

export function setDraftLoadoutChoice(draftId: DraftId, choice: ThreadLoadout | null) {
  useDraftLoadouts.setState(({ choices }) => {
    const { [draftId]: _replaced, ...rest } = choices;
    return { choices: choice === null ? rest : { ...rest, [draftId]: choice } };
  });
}

export const readDraftLoadoutChoice = (draftId: DraftId): ThreadLoadout | null =>
  useDraftLoadouts.getState().choices[draftId] ?? null;

export const useDraftLoadoutChoice = (draftId: DraftId | null): ThreadLoadout | null =>
  useDraftLoadouts((state) => (draftId === null ? null : (state.choices[draftId] ?? null)));

/**
 * The picker's rule for drafts and threads alike: picking what already runs changes nothing
 * unless the agent proposed it, and any other pick is the user's and stands, Solo included.
 */
export function pickLoadout(current: ThreadLoadout | null, loadoutId: string) {
  if (loadoutId === (current?.id ?? SOLO_LOADOUT_ID) && current?.setBy !== "agent") {
    return current;
  }
  return { id: loadoutId, reason: null, setBy: "user" } satisfies ThreadLoadout;
}

/**
 * What the first send creates the thread with. A pick whose loadout was deleted since launches
 * solo, which is what the picker shows for it, rather than a choice the server would refuse.
 */
export function draftLaunchLoadout(
  choice: ThreadLoadout | null,
  loadouts: ReadonlyArray<Loadout>,
): { readonly threadLoadout: ThreadLoadout | null; readonly active: Loadout } {
  const active = resolveLoadout(loadouts, choice?.id);
  return { threadLoadout: choice !== null && active.id === choice.id ? choice : null, active };
}
