import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  deriveLedgerProgress,
  formatLedgerProgress,
} from "@t3tools/client-runtime/state/thread-ledger";

import { useThreadLedgerIfSupported } from "~/hooks/useThreadLedgerIfSupported";
import { Badge } from "../ui/badge";
import { ThreadTabSection } from "../thread/ThreadOverviewTab";
import { InvestigationPanel } from "./InvestigationPanel";
import { LedgerPanel } from "./LedgerPanel";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { BuildModeBar } from "./BuildModeBar";

/** The ledger in the thread details card; renders nothing without a ledger or the capability. */
export function ThreadLedgerDetailsSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  if (ledger === null) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-ledger-heading" title="Task ledger">
      <InvestigationPanel threadRef={threadRef} ledger={ledger} />
      <LedgerPanel threadRef={threadRef} ledger={ledger} />
      {/* Fork: a ledger made while planning offers the plan card's build actions. */}
      <BuildModeBar threadRef={threadRef} className="px-2.5 pt-2" />
    </ThreadDetailsSection>
  );
}

/** The ledger in the Overview tab; renders nothing without a ledger or the capability. */
export function ThreadLedgerOverviewSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  if (ledger === null) return null;
  return (
    <ThreadTabSection title="Task ledger">
      <InvestigationPanel threadRef={threadRef} ledger={ledger} />
      <LedgerPanel threadRef={threadRef} ledger={ledger} />
      <BuildModeBar threadRef={threadRef} className="px-2.5 pt-2" />
    </ThreadTabSection>
  );
}

/** A small count in the header while the ledger has unfinished work, gone once it settles. */
export function ThreadLedgerHeaderProgress({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  if (ledger === null) return null;
  const progress = deriveLedgerProgress(ledger);
  if (!progress.active) return null;
  return (
    <Badge variant="info" size="sm">
      <span aria-hidden>
        Ledger {progress.closed}/{progress.scope}
      </span>
      <span className="sr-only">Task ledger: {formatLedgerProgress(progress)}</span>
    </Badge>
  );
}
