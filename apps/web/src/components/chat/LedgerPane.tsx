/** Fork: the task ledger's own pane, left of the chat column, or a sheet on narrow layouts. */
import { deriveLedgerProgress } from "@t3tools/client-runtime/state/thread-ledger";
import type { Ledger, ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronsLeftRightIcon,
  ChevronsRightLeftIcon,
  ListChecksIcon,
  PanelLeftCloseIcon,
} from "lucide-react";
import { type CSSProperties, useState } from "react";

import { useThreadLedgerIfSupported } from "~/hooks/useThreadLedgerIfSupported";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useLedgerPaneStore } from "~/ledgerPaneStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetPopup } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LedgerPaneBody } from "./LedgerPaneBody";

const LEDGER_PANE_MIN_WIDTH = 320;
// Wide enough that a typical item title and its badges sit on one line.
const LEDGER_PANE_DEFAULT_WIDTH = 520;
const LEDGER_PANE_MAX_VIEWPORT_FRACTION = 0.6;
/** The chat column keeps at least this much, so its composer never overflows. */
const CHAT_COLUMN_MIN_WIDTH = 420;

/** The pane's width cap: what it has now plus what the chat column can still give up. */
function useLedgerPaneMaxWidth() {
  const [maxWidth, setMaxWidth] = useState(() =>
    Math.floor(
      (typeof window === "undefined" ? 1280 : window.innerWidth) *
        LEDGER_PANE_MAX_VIEWPORT_FRACTION,
    ),
  );
  const observe = (host: HTMLElement) => {
    const chatColumn = host.parentElement?.querySelector<HTMLElement>(
      ":scope > [data-chat-column]",
    );
    // The pane and the chat column trade width, so their sum is stable through a drag.
    const measure = () => {
      const fractionCap = Math.floor(window.innerWidth * LEDGER_PANE_MAX_VIEWPORT_FRACTION);
      const rowCap =
        chatColumn === null || chatColumn === undefined
          ? Infinity
          : host.offsetWidth + chatColumn.clientWidth - CHAT_COLUMN_MIN_WIDTH;
      setMaxWidth(Math.max(LEDGER_PANE_MIN_WIDTH, Math.min(fractionCap, rowCap)));
    };
    measure();
    const stopChat = chatColumn ? observeResize(chatColumn, measure) : undefined;
    window.addEventListener("resize", measure);
    return () => {
      stopChat?.();
      window.removeEventListener("resize", measure);
    };
  };
  return { maxWidth, observe };
}

function LedgerPaneHeader({
  ledger,
  wide,
  inline,
  onToggleWide,
  onClose,
}: {
  ledger: Ledger;
  wide: boolean;
  inline: boolean;
  onToggleWide: () => void;
  onClose: () => void;
}) {
  const progress = deriveLedgerProgress(ledger);
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border px-3",
        inline && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        inline && isElectron && "drag-region",
      )}
    >
      <ListChecksIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm font-medium text-foreground">Task ledger</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {progress.closed}/{progress.scope}
      </span>
      <div className="ms-auto flex items-center gap-0.5 [-webkit-app-region:no-drag]">
        {inline ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-pressed={wide}
                  aria-label={wide ? "Narrow the ledger" : "Widen the ledger"}
                  onClick={onToggleWide}
                >
                  {wide ? <ChevronsRightLeftIcon /> : <ChevronsLeftRightIcon />}
                </Button>
              }
            />
            <TooltipPopup side="bottom">{wide ? "Narrow" : "Widen"}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Hide the ledger"
                data-ledger-pane-close
                onClick={onClose}
              >
                <PanelLeftCloseIcon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Hide the ledger</TooltipPopup>
        </Tooltip>
      </div>
    </header>
  );
}

function InlineLedgerPane({ threadRef, ledger }: { threadRef: ScopedThreadRef; ledger: Ledger }) {
  const [wide, setWide] = useState(false);
  const setOpen = useLedgerPaneStore((state) => state.setOpen);
  const { maxWidth, observe } = useLedgerPaneMaxWidth();
  const { width, handlers } = useResizableWidth({
    storageKey: "t3code:ledger-pane-width",
    defaultWidth: LEDGER_PANE_DEFAULT_WIDTH,
    minWidth: LEDGER_PANE_MIN_WIDTH,
    maxWidth,
    edge: "right",
  });
  return (
    <aside
      ref={observe}
      aria-label="Task ledger"
      data-ledger-pane
      className="relative flex h-full min-h-0 shrink-0 flex-col self-stretch border-e border-border bg-background [[data-panel-animations=true]_&]:motion-safe:starting:w-0! [[data-panel-animations=true]_&]:motion-safe:transition-[width] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out"
      style={
        {
          [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
          width: wide ? `${maxWidth}px` : `var(${RESIZABLE_WIDTH_PROPERTY})`,
        } as CSSProperties
      }
    >
      <LedgerPaneHeader
        ledger={ledger}
        wide={wide}
        inline
        onToggleWide={() => setWide(!wide)}
        onClose={() => setOpen(false, false)}
      />
      <ScrollArea className="min-h-0 flex-1" scrollbarGutter>
        <LedgerPaneBody threadRef={threadRef} ledger={ledger} />
      </ScrollArea>
      {/* Widened, the pane takes all the room it may; dragging would only fight that. */}
      {wide ? null : <RightPanelResizeHandle handlers={handlers} className="-right-1 left-auto" />}
    </aside>
  );
}

function SheetLedgerPane({ threadRef, ledger }: { threadRef: ScopedThreadRef; ledger: Ledger }) {
  const open = useLedgerPaneStore((state) => state.sheetOpen);
  const setOpen = useLedgerPaneStore((state) => state.setOpen);
  return (
    <Sheet open={open} onOpenChange={(next) => setOpen(true, next)}>
      <SheetPopup
        side="left"
        showCloseButton={false}
        aria-label="Task ledger"
        className="w-[min(92vw,34rem)] max-w-[34rem]"
      >
        <LedgerPaneHeader
          ledger={ledger}
          wide={false}
          inline={false}
          onToggleWide={() => {}}
          onClose={() => setOpen(true, false)}
        />
        <ScrollArea className="min-h-0 flex-1" scrollbarGutter>
          <LedgerPaneBody threadRef={threadRef} ledger={ledger} />
        </ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}

/** Renders nothing for a thread without a ledger, or while the pane is hidden. */
export function LedgerPane({ threadRef, sheet }: { threadRef: ScopedThreadRef; sheet: boolean }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  const open = useLedgerPaneStore((state) => state.open);
  if (ledger === null) return null;
  if (sheet) return <SheetLedgerPane threadRef={threadRef} ledger={ledger} />;
  return open ? <InlineLedgerPane threadRef={threadRef} ledger={ledger} /> : null;
}
