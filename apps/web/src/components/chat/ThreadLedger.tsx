import type { Ledger, LedgerItem, ScopedThreadRef } from "@t3tools/contracts";
import {
  deriveLedgerProgress,
  deriveLedgerView,
  formatLedgerProgress,
  ledgerItemStatusLabel,
  type LedgerViewRow,
} from "@t3tools/client-runtime/state/thread-ledger";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  ScaleIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { useThreadLedgerIfSupported } from "~/hooks/useThreadLedgerIfSupported";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ThreadTabSection } from "../thread/ThreadOverviewTab";
import { InvestigationPanel } from "./InvestigationPanel";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { BuildModeBar } from "./BuildModeBar";

const ITEM_STATUS_PRESENTATION: Record<
  LedgerItem["status"],
  {
    readonly Icon: ComponentType<{ className?: string }>;
    readonly iconClass: string;
    readonly badge: "outline" | "info" | "success" | "secondary";
  }
> = {
  open: { Icon: CircleIcon, iconClass: "text-muted-foreground", badge: "outline" },
  in_progress: { Icon: CircleDotIcon, iconClass: "text-info", badge: "info" },
  closed: { Icon: CircleCheckIcon, iconClass: "text-success", badge: "success" },
  dropped: { Icon: CircleMinusIcon, iconClass: "text-muted-foreground/60", badge: "secondary" },
  deferred: { Icon: CircleDashedIcon, iconClass: "text-muted-foreground/60", badge: "secondary" },
};

const JUDGING_PRESENTATION = {
  Icon: ScaleIcon,
  iconClass: "text-warning",
  badge: "warning",
} as const;

// Indentation per nesting level, capped so deep trees stay readable in a narrow panel.
const DEPTH_INDENT = ["", "ps-4", "ps-8", "ps-12"] as const;
const indentFor = (depth: number) => DEPTH_INDENT[Math.min(depth, DEPTH_INDENT.length - 1)];

function LedgerItemRow({
  item,
  depth = 0,
  blockedBy = [],
}: {
  item: LedgerItem;
  depth?: number;
  blockedBy?: LedgerViewRow["blockedBy"];
}) {
  const { Icon, iconClass, badge } =
    item.judging === true ? JUDGING_PRESENTATION : ITEM_STATUS_PRESENTATION[item.status];
  return (
    <li className={`flex flex-col gap-0.5 ${indentFor(depth)}`}>
      <div className="flex items-start gap-2">
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${iconClass}`} />
        <span
          className={
            item.status === "dropped"
              ? "min-w-0 flex-1 break-words text-sm text-muted-foreground line-through"
              : "min-w-0 flex-1 break-words text-sm font-medium text-foreground/80"
          }
        >
          {item.title}
        </span>
        {blockedBy.length === 0 ? null : (
          <Badge variant="outline" size="sm" title={`Blocked by ${blockedBy.join(", ")}`}>
            blocked by{" "}
            {blockedBy.length === 1 ? blockedBy[0] : `${blockedBy[0]} +${blockedBy.length - 1}`}
          </Badge>
        )}
        <Badge variant={badge} size="sm">
          {ledgerItemStatusLabel(item)}
        </Badge>
      </div>
      <div className="flex flex-col gap-0.5 ps-6 text-2xs text-muted-foreground">
        {item.acceptance.trim() === "" ? null : (
          <p className="line-clamp-3 break-words">Done when: {item.acceptance}</p>
        )}
        {item.evidence === null || item.evidence.trim() === "" ? null : (
          <p className="line-clamp-4 break-words">Evidence: {item.evidence}</p>
        )}
        {item.dropReason === null || item.dropReason.trim() === "" ? null : (
          <p className="line-clamp-3 break-words">Dropped: {item.dropReason}</p>
        )}
        {item.deferReason === undefined || item.deferReason.trim() === "" ? null : (
          <p className="line-clamp-3 break-words">Deferred: {item.deferReason}</p>
        )}
        {item.judgeError === undefined ? null : (
          <p className="line-clamp-3 break-words">Judge did not finish: {item.judgeError}</p>
        )}
        {item.verdict === null ? null : (
          <p className="flex flex-wrap items-center gap-1.5 break-words">
            <Badge variant={item.verdict.outcome === "pass" ? "success" : "error"} size="sm">
              Judge {item.verdict.outcome === "pass" ? "passed" : "failed"}
            </Badge>
            <span className="min-w-0 break-words">{item.verdict.notes}</span>
          </p>
        )}
      </div>
    </li>
  );
}

function LedgerList({ heading, entries }: { heading: string; entries: ReadonlyArray<string> }) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-2xs font-medium text-muted-foreground">{heading}</p>
      <ul className="m-0 list-disc ps-4 text-xs text-foreground/80 marker:text-muted-foreground/60">
        {entries.map((entry, index) => (
          // Win conditions are bare strings with no id; the list is replaced whole, never reordered.
          // oxlint-disable-next-line react/no-array-index-key
          <li key={`${index}:${entry}`} className="break-words">
            {entry}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeferredItems({ items }: { items: ReadonlyArray<LedgerItem> }) {
  if (items.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-2xs font-medium text-muted-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3 transition-transform group-data-panel-open:rotate-90"
        />
        Deferred ({items.length})
      </CollapsibleTrigger>
      {/* Collapsed by default and unmounted while closed, so a long backlog costs nothing. */}
      <CollapsiblePanel animate={false}>
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {items.map((item) => (
            <LedgerItemRow key={item.id} item={item} />
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ThreadLedgerView({ ledger }: { ledger: Ledger }) {
  const progress = deriveLedgerProgress(ledger);
  const view = deriveLedgerView(ledger);
  return (
    <div data-thread-ledger-panel className="flex flex-col gap-3 px-2.5 py-1">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words text-sm font-medium text-foreground/80">{ledger.title}</p>
        <Badge variant={ledger.closedAt === null ? "info" : "secondary"} size="sm">
          {ledger.closedAt === null ? "Active" : "Closed"}
        </Badge>
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">{formatLedgerProgress(progress)}</p>
      {ledger.startState.trim() === "" ? null : (
        <p className="line-clamp-4 break-words text-2xs text-muted-foreground">
          Started from: {ledger.startState}
        </p>
      )}
      <LedgerList heading="Win conditions" entries={ledger.winConditions} />
      {ledger.checkpoints.length === 0 ? null : (
        <div className="flex flex-col gap-0.5">
          <p className="text-2xs font-medium text-muted-foreground">Checkpoints</p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {ledger.checkpoints.map((checkpoint) => (
              <li key={checkpoint.id} className="flex items-start gap-2 text-xs">
                {checkpoint.reached ? (
                  <CircleCheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : (
                  <CircleIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 break-words text-foreground/80">{checkpoint.title}</span>
                <span className="sr-only">{checkpoint.reached ? "reached" : "not reached"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {view.rows.map((row) => (
          <LedgerItemRow
            key={row.item.id}
            item={row.item}
            depth={row.depth}
            blockedBy={row.blockedBy}
          />
        ))}
      </ul>
      <DeferredItems items={view.deferred} />
    </div>
  );
}

/** The ledger in the thread details card; renders nothing without a ledger or the capability. */
export function ThreadLedgerDetailsSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const ledger = useThreadLedgerIfSupported(threadRef);
  if (ledger === null) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-ledger-heading" title="Task ledger">
      <InvestigationPanel threadRef={threadRef} ledger={ledger} />
      <ThreadLedgerView ledger={ledger} />
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
      <ThreadLedgerView ledger={ledger} />
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
