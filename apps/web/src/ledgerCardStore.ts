// Fork: how the thread details stack is folded. One setting for every thread, remembered.
import type { LedgerItemId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface LedgerCardState {
  /** The thread details card above the ledger, folded to its title row. */
  detailsCollapsed: boolean;
  ledgerCollapsed: boolean;
  /** The ledger card in its long form: wider, with item detail and the Agents view. */
  ledgerWide: boolean;
  /** The item the long form opens on; set by clicking it in the short form. */
  focusItemId: LedgerItemId | null;
  toggleDetails: () => void;
  toggleLedger: () => void;
  setLedgerWide: (wide: boolean) => void;
  openItem: (itemId: LedgerItemId) => void;
}

export const useLedgerCardStore = create<LedgerCardState>()(
  persist(
    (set) => ({
      detailsCollapsed: false,
      ledgerCollapsed: false,
      ledgerWide: false,
      focusItemId: null,
      toggleDetails: () => set((state) => ({ detailsCollapsed: !state.detailsCollapsed })),
      toggleLedger: () => set((state) => ({ ledgerCollapsed: !state.ledgerCollapsed })),
      setLedgerWide: (ledgerWide) => set({ ledgerWide, ledgerCollapsed: false, focusItemId: null }),
      openItem: (focusItemId) => set({ ledgerWide: true, ledgerCollapsed: false, focusItemId }),
    }),
    {
      name: "t3code:ledger-card:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ detailsCollapsed, ledgerCollapsed, ledgerWide }) => ({
        detailsCollapsed,
        ledgerCollapsed,
        ledgerWide,
      }),
    },
  ),
);
