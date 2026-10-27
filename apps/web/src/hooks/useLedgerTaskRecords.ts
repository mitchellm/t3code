// Fork: the task records the ledger panel shows, quiet through streamed text and unlinked tasks.
import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  createLedgerTaskRecordsAtom,
  type LedgerTaskRecord,
} from "@t3tools/client-runtime/state/ledger-panel";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "~/state/threads";

const ledgerTaskRecordsAtomFamily = Atom.family((key: string) =>
  createLedgerTaskRecordsAtom(environmentThreadDetails.stateAtom(parseThreadKey(key))).pipe(
    Atom.setIdleTTL(0),
    Atom.withLabel(`environment-thread-ledger-tasks:${key}`),
  ),
);

export function useLedgerTaskRecords(ref: ScopedThreadRef): ReadonlyArray<LedgerTaskRecord> {
  return useAtomValue(ledgerTaskRecordsAtomFamily(threadKey(ref)));
}
