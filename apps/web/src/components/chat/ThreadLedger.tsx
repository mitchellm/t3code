import type { Ledger, LedgerItem, ScopedThreadRef } from "@t3tools/contracts";
import { deriveLedgerPanel, type LedgerPanelRow } from "@t3tools/client-runtime/state/ledger-panel";
import {
  deriveLedgerProgress,
  formatLedgerProgress,
} from "@t3tools/client-runtime/state/thread-ledger";
import {
  ChevronDownIcon,
  ChevronsLeftRightIcon,
  ChevronsRightLeftIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { useLedgerTaskRecords } from "~/hooks/useLedgerTaskRecords";
import { useThreadLedgerIfSupported } from "~/hooks/useThreadLedgerIfSupported";
import { useLedgerCardStore } from "~/ledgerCardStore";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadTabSection } from "../thread/ThreadOverviewTab";
import { LedgerPaneBody } from "./LedgerPaneBody";

const STATUS_ICON: Record<
  LedgerItem["status"],
  { readonly Icon: ComponentType<{ className?: string }>; readonly className: string }
> = {
  open: { Icon: CircleIcon, className: "text-muted-foreground" },
  in_progress: { Icon: CircleDotIcon, className: "text-info" },
  closed: { Icon: CircleCheckIcon, className: "text-success" },
  dropped: { Icon: CircleMinusIcon, className: "text-muted-foreground/60" },
  deferred: { Icon: CircleDashedIcon, className: "text-warning" },
};

// The short form is a glance, not the list; the long form has every item.
const SHORT_FORM_ROWS = 6;

function ShortFormRow({ row, onOpen }: { row: LedgerPanelRow; onOpen: () => void }) {
  const { item } = row;
  const { Icon, className } = STATUS_ICON[item.status];
  const working = row.agents.some((line) => line.tone === "running");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0", className)} />
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-foreground/85">
          {item.title}
        </span>
        {working ? (
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" />
        ) : null}
        {working ? <span className="sr-only">, agents working</span> : null}
      </button>
    </li>
  );
}

/** The plan at a glance: progress, then what is moving and what is next. */
function LedgerShortForm({
  threadRef,
  ledger,
  onOpenItem,
}: {
  threadRef: ScopedThreadRef;
  ledger: Ledger;
  onOpenItem: (itemId: LedgerItem["id"]) => void;
}) {
  const records = useLedgerTaskRecords(threadRef);
  const panel = deriveLedgerPanel(ledger, records);
  const { count } = panel;
  const ordered = [
    ...panel.active.filter((row) => row.item.status === "in_progress"),
    ...panel.active.filter((row) => row.item.status === "open"),
  ];
  const shown = ordered.slice(0, SHORT_FORM_ROWS);
  const rest = [
    ordered.length > shown.length ? `${ordered.length - shown.length} more open` : null,
    count.done > 0 ? `${count.done} done` : null,
    count.deferred > 0 ? `${count.deferred} deferred` : null,
  ].filter((part) => part !== null);
  return (
    <div className="flex flex-col gap-2 px-2.5 pb-2.5">
      <div className="flex flex-col gap-1.5 px-1.5">
        <p className="m-0 line-clamp-2 break-words text-xs font-medium text-foreground">
          {ledger.title}
        </p>
        <div aria-hidden className="h-1 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full bg-success"
            style={{ width: `${Math.round(count.fraction * 100)}%` }}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="m-0 px-1.5 text-xs text-muted-foreground">
          {ledger.closedAt === null ? "Nothing open right now." : "Finished."}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((row) => (
            <ShortFormRow key={row.item.id} row={row} onOpen={() => onOpenItem(row.item.id)} />
          ))}
        </ul>
      )}
      {rest.length === 0 ? null : (
        <p className="m-0 px-1.5 text-2xs text-muted-foreground">{rest.join(" · ")}</p>
      )}
    </div>
  );
}

/**
 * Fork: the ledger's card in the thread details stack. Short form by default; widening it, or
 * opening an item, shows the long form with every item, its evidence and the agents.
 */
export function ThreadLedgerCard({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  const collapsed = useLedgerCardStore((state) => state.ledgerCollapsed);
  const wide = useLedgerCardStore((state) => state.ledgerWide);
  const focusItemId = useLedgerCardStore((state) => state.focusItemId);
  const toggleLedger = useLedgerCardStore((state) => state.toggleLedger);
  const setLedgerWide = useLedgerCardStore((state) => state.setLedgerWide);
  const openItem = useLedgerCardStore((state) => state.openItem);
  if (ledger === null) return null;
  const progress = deriveLedgerProgress(ledger);
  return (
    <section
      aria-label="Task ledger"
      className={cn(
        "dropdown-glass isolate contain-paint grid max-h-full min-h-0 overflow-hidden rounded-2xl",
        collapsed ? "grid-rows-[auto]" : "grid-rows-[auto_minmax(0,1fr)]",
        // Wide, it grows leftward over the chat; the long form needs the room.
        wide && !collapsed ? "w-[min(38rem,calc(100vw-6rem))]" : "w-full",
      )}
    >
      <div className="flex h-8 min-w-0 items-center gap-1 ps-4 pe-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={toggleLedger}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-2xs font-medium text-muted-foreground select-none hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="truncate">Task ledger</span>
          <span className="tabular-nums text-muted-foreground/80">
            {progress.closed}/{progress.scope}
          </span>
          <span className="sr-only">{formatLedgerProgress(progress)}</span>
        </button>
        {collapsed ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-pressed={wide}
                  aria-label={wide ? "Show the short form" : "Show the long form"}
                  onClick={() => setLedgerWide(!wide)}
                >
                  {wide ? <ChevronsRightLeftIcon /> : <ChevronsLeftRightIcon />}
                </Button>
              }
            />
            <TooltipPopup side="bottom">{wide ? "Short form" : "Long form"}</TooltipPopup>
          </Tooltip>
        )}
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={collapsed ? "Expand the ledger" : "Collapse the ledger"}
          onClick={toggleLedger}
        >
          <ChevronDownIcon className={cn(collapsed && "-rotate-90")} />
        </Button>
      </div>
      {collapsed ? null : wide ? (
        <ScrollArea scrollFade className="min-h-0">
          <LedgerPaneBody threadRef={threadRef} ledger={ledger} initialOpenItemId={focusItemId} />
        </ScrollArea>
      ) : (
        <ScrollArea scrollFade className="min-h-0">
          <LedgerShortForm threadRef={threadRef} ledger={ledger} onOpenItem={openItem} />
        </ScrollArea>
      )}
    </section>
  );
}

/** The ledger in the Overview tab, which has the width for the long form. */
export function ThreadLedgerOverviewSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  if (ledger === null) return null;
  return (
    <ThreadTabSection title="Task ledger">
      <LedgerPaneBody threadRef={threadRef} ledger={ledger} />
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
