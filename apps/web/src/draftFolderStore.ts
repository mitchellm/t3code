/**
 * Fork: the folder a draft's thread is filed under once its first send creates it. A draft has no
 * thread to hold the folder yet, so it lives here, per draft. Client-only like the draft loadout:
 * a reload drops it and the thread lands unfiled.
 */
import { create } from "zustand";

import { type DraftId, useComposerDraftStore } from "./composerDraftStore";

const useDraftFolders = create<{ readonly folders: Readonly<Record<string, string>> }>(() => ({
  folders: {},
}));

// A sent or discarded draft's session goes, and its folder with it.
useComposerDraftStore.subscribe((drafts) => {
  const { folders } = useDraftFolders.getState();
  const gone = Object.keys(folders).filter(
    (draftId) => !(draftId in drafts.draftThreadsByThreadKey),
  );
  if (gone.length === 0) return;
  useDraftFolders.setState({
    folders: Object.fromEntries(
      Object.entries(folders).filter(([draftId]) => !gone.includes(draftId)),
    ),
  });
});

/** A null folder clears it, so a reused draft opened from a project button is unfiled again. */
export function setDraftFolder(draftId: DraftId, folder: string | null) {
  useDraftFolders.setState(({ folders }) => {
    const { [draftId]: _replaced, ...rest } = folders;
    return { folders: folder === null ? rest : { ...rest, [draftId]: folder } };
  });
}

/** What a draft's first send adds to the new thread's bootstrap. Read at send time, not render. */
export const draftFolderBootstrap = (draftId: DraftId | null): { folder?: string } => {
  const folder = draftId === null ? undefined : useDraftFolders.getState().folders[draftId];
  return folder === undefined ? {} : { folder };
};
