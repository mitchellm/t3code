// Fork: whether the ledger pane is shown. One setting for every thread; it renders only where a
// thread has a ledger.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface LedgerPaneState {
  /** The inline pane beside the chat column; remembered across reloads. */
  open: boolean;
  /** Narrow layouts show the pane as a sheet over the chat, so it starts closed on every load. */
  sheetOpen: boolean;
  toggle: (sheet: boolean) => void;
  setOpen: (sheet: boolean, open: boolean) => void;
}

export const useLedgerPaneStore = create<LedgerPaneState>()(
  persist(
    (set) => ({
      open: true,
      sheetOpen: false,
      toggle: (sheet) =>
        set((state) => (sheet ? { sheetOpen: !state.sheetOpen } : { open: !state.open })),
      setOpen: (sheet, open) => set(sheet ? { sheetOpen: open } : { open }),
    }),
    {
      name: "t3code:ledger-pane:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ open }) => ({ open }),
    },
  ),
);
