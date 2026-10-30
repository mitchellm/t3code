import type { Ledger, ScopedThreadRef } from "@t3tools/contracts";
import {
  deriveLedgerProgress,
  formatLedgerProgress,
} from "@t3tools/client-runtime/state/thread-ledger";
import { ListChecksIcon } from "lucide-react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useThreadLedgerIfSupported } from "~/hooks/useThreadLedgerIfSupported";
import { useLedgerPaneStore } from "~/ledgerPaneStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadTabSection } from "../thread/ThreadOverviewTab";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Fork: the pane is the ledger's home; the toggle opens it inline or, when narrow, as a sheet. */
function useLedgerPaneToggle() {
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const open = useLedgerPaneStore((state) => (sheet ? state.sheetOpen : state.open));
  const toggle = useLedgerPaneStore((state) => state.toggle);
  const setOpen = useLedgerPaneStore((state) => state.setOpen);
  return { open, toggle: () => toggle(sheet), show: () => setOpen(sheet, true) };
}

/** Elsewhere in the thread, the ledger is a progress line that opens the pane. */
function LedgerSummary({ ledger }: { ledger: Ledger }) {
  const progress = deriveLedgerProgress(ledger);
  const pane = useLedgerPaneToggle();
  const fraction = progress.scope === 0 ? 0 : progress.closed / progress.scope;
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-1">
      <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 flex-1 break-words text-sm text-foreground/85">{ledger.title}</p>
        {pane.open ? null : (
          <Button variant="outline" size="xs" onClick={pane.show}>
            Open ledger
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-success" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatLedgerProgress(progress)}
        </span>
      </div>
    </div>
  );
}

/** The ledger in the thread details card; renders nothing without a ledger or the capability. */
export function ThreadLedgerDetailsSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  if (ledger === null) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-ledger-heading" title="Task ledger">
      <LedgerSummary ledger={ledger} />
    </ThreadDetailsSection>
  );
}

/** The ledger in the Overview tab; renders nothing without a ledger or the capability. */
export function ThreadLedgerOverviewSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  if (ledger === null) return null;
  return (
    <ThreadTabSection title="Task ledger">
      <LedgerSummary ledger={ledger} />
    </ThreadTabSection>
  );
}

/** The header's way into the ledger pane: its progress while work is open, a plain icon after. */
export function ThreadLedgerHeaderProgress({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  const pane = useLedgerPaneToggle();
  if (ledger === null) return null;
  const progress = deriveLedgerProgress(ledger);
  const label = pane.open ? "Hide the ledger" : "Show the ledger";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={progress.active ? "outline" : "ghost-muted"}
            size="xs"
            aria-pressed={pane.open}
            aria-label={`${label}: ${formatLedgerProgress(progress)}`}
            className="shrink-0 [-webkit-app-region:no-drag]"
            onClick={pane.toggle}
          >
            <ListChecksIcon aria-hidden className={progress.active ? "text-info" : undefined} />
            <span className="tabular-nums">
              {progress.closed}/{progress.scope}
            </span>
          </Button>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
