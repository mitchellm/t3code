/**
 * Fork: the loadout a draft will start under. A draft has no thread to hold the choice yet, so it
 * lives here, per draft, until the first send creates the thread with it. Client-only like the
 * Investigate fields: a reload drops it, and the picker then shows Solo again.
 */
import { type Loadout, SOLO_LOADOUT_ID, type ThreadLoadout } from "@t3tools/contracts";
import { resolveLoadout } from "@t3tools/shared/loadouts";
import { create } from "zustand";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";

const useDraftLoadouts = create<{
  readonly choices: Readonly<Record<string, ThreadLoadout>>;
}>(() => ({ choices: {} }));

/**
 * A pick lives as long as its draft. A sent draft is finalized only once its thread has started,
 * which is after the thread got its loadout, and a discarded one is cleared; either way the draft
 * session goes, and so does the pick. Picks are rare, so most store changes return at once.
 */
useComposerDraftStore.subscribe((drafts) => {
  const { choices } = useDraftLoadouts.getState();
  const gone = Object.keys(choices).filter(
    (draftId) => !(draftId in drafts.draftThreadsByThreadKey),
  );
  if (gone.length === 0) return;
  useDraftLoadouts.setState({
    choices: Object.fromEntries(
      Object.entries(choices).filter(([draftId]) => !gone.includes(draftId)),
    ),
  });
});

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
 * The choice the picker shows. A draft's send creates the thread and sets its loadout in two
 * steps; the pick stays on screen between them, while the send is in flight, rather than flashing
 * Solo. Once the send settles, a thread is shown as it is, Solo included.
 */
export function shownLoadoutChoice(input: {
  readonly shell: { readonly loadout?: ThreadLoadout | null | undefined } | null;
  readonly draftChoice: ThreadLoadout | null;
  readonly sending: boolean;
}): ThreadLoadout | null {
  if (input.shell === null) return input.draftChoice;
  return input.shell.loadout ?? (input.sending ? input.draftChoice : null);
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
