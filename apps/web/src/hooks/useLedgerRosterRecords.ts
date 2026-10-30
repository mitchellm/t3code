// Fork: the task records the ledger roster shows, quiet through streamed text and task progress.
import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  createLedgerRosterRecordsAtom,
  type LedgerRosterRecord,
} from "@t3tools/client-runtime/state/ledger-roster";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "~/state/threads";

const ledgerRosterRecordsAtomFamily = Atom.family((key: string) =>
  createLedgerRosterRecordsAtom(environmentThreadDetails.stateAtom(parseThreadKey(key))).pipe(
    Atom.setIdleTTL(0),
    Atom.withLabel(`environment-thread-ledger-roster:${key}`),
  ),
);

export function useLedgerRosterRecords(ref: ScopedThreadRef): ReadonlyArray<LedgerRosterRecord> {
  return useAtomValue(ledgerRosterRecordsAtomFamily(threadKey(ref)));
}
