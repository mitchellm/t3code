/** Fork: the task ledger, one line per item; a click opens an item, finished work folds away. */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveLedgerPanel,
  formatLedgerPanelCount,
  type LedgerPanelRow,
  type LedgerRowBadge,
} from "@t3tools/client-runtime/state/ledger-panel";
import { ledgerItemStatusLabel } from "@t3tools/client-runtime/state/thread-ledger";
import type { Ledger, LedgerItem, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { useLedgerTaskRecords } from "~/hooks/useLedgerTaskRecords";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { LedgerAgentLines, type LedgerAgentContext } from "./LedgerAgentLines";

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

// Indentation per nesting level, capped so deep trees stay readable in a narrow panel.
const DEPTH_INDENT = ["", "ps-5", "ps-10", "ps-14"] as const;
const indentFor = (depth: number) => DEPTH_INDENT[Math.min(depth, DEPTH_INDENT.length - 1)];

function LedgerBadge({ badge }: { badge: LedgerRowBadge }) {
  switch (badge.kind) {
    case "judging":
      return (
        <Badge variant="info" size="sm">
          {badge.label}
        </Badge>
      );
    case "passed":
      return (
        <Badge variant="success" size="sm">
          {badge.label}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="error" size="sm">
          {badge.label}
        </Badge>
      );
    case "blocked":
      return (
        <Badge variant="outline" size="sm" title={`Blocked by ${badge.blockedBy.join(", ")}`}>
          {badge.label}
        </Badge>
      );
    case "agents":
      return (
        <Badge variant="outline" size="sm">
          {badge.running ? <span aria-hidden className="size-1.5 rounded-full bg-info" /> : null}
          {badge.label}
          {badge.running ? <span className="sr-only">, working</span> : null}
        </Badge>
      );
  }
}

/** A folded group, such as Done or the goal; closed by default and unmounted while closed. */
function LedgerFold({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-border/70">
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-sm py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <ChevronRightIcon aria-hidden className="size-3.5 group-data-panel-open:rotate-90" />
          {label}
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <div className="pb-2">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="m-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-foreground/85">
        {children}
      </div>
    </div>
  );
}

function JudgeField({ item, requiresJudge }: { item: LedgerItem; requiresJudge: boolean }) {
  if (item.judging === true) {
    return (
      <DetailField label="Judge">
        {item.setAside === undefined
          ? "Judging now"
          : `Judging the agent's ${item.setAside.status === "dropped" ? "drop" : "defer"}: ${item.setAside.reason}`}
      </DetailField>
    );
  }
  if (item.verdict !== null) {
    return (
      <DetailField label="Judge">
        <span className={item.verdict.outcome === "pass" ? "text-success" : "text-destructive"}>
          {item.verdict.outcome === "pass" ? "Passed" : "Failed"}
        </span>
        {item.verdict.notes.trim() === "" ? null : `: ${item.verdict.notes}`}
      </DetailField>
    );
  }
  if (item.judgeError !== undefined) {
    return <DetailField label="Judge">Did not finish: {item.judgeError}</DetailField>;
  }
  if (requiresJudge && (item.status === "open" || item.status === "in_progress")) {
    return (
      <DetailField label="Judge">
        <span className="text-muted-foreground">Runs when the item closes</span>
      </DetailField>
    );
  }
  return null;
}

function LedgerItemDetail({
  row,
  requiresJudge,
  context,
}: {
  row: LedgerPanelRow;
  requiresJudge: boolean;
  context: LedgerAgentContext;
}) {
  const { item } = row;
  return (
    <div className="mt-0.5 mb-1.5 ms-2.5 flex flex-col gap-2 border-s-2 border-border ps-3 py-1 text-xs">
      <DetailField label="Done when">
        {item.acceptance.trim() === "" ? (
          <span className="text-muted-foreground">Not written</span>
        ) : (
          item.acceptance
        )}
      </DetailField>
      {row.agents.length === 0 ? null : (
        <div className="flex flex-col gap-0.5">
          <p className="m-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Agents
          </p>
          <LedgerAgentLines lines={row.agents} context={context} />
        </div>
      )}
      <DetailField label="Evidence">
        {item.evidence === null || item.evidence.trim() === "" ? (
          <span className="text-muted-foreground">None yet</span>
        ) : (
          item.evidence
        )}
      </DetailField>
      <JudgeField item={item} requiresJudge={requiresJudge} />
      {item.dropReason === null || item.dropReason.trim() === "" ? null : (
        <DetailField label="Dropped">{item.dropReason}</DetailField>
      )}
      {item.deferReason === undefined || item.deferReason.trim() === "" ? null : (
        <DetailField label="Deferred">{item.deferReason}</DetailField>
      )}
    </div>
  );
}

function LedgerRow({
  row,
  requiresJudge,
  context,
}: {
  row: LedgerPanelRow;
  requiresJudge: boolean;
  context: LedgerAgentContext;
}) {
  const [open, setOpen] = useState(false);
  const { item } = row;
  const { Icon, className: iconClass } = STATUS_ICON[item.status];
  return (
    <li className={indentFor(row.depth)}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-panel-open:bg-accent">
          <Icon aria-hidden className={`size-3.5 shrink-0 ${iconClass}`} />
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">{item.id}</span>
          <span
            className={
              item.status === "dropped"
                ? "min-w-0 flex-1 truncate text-muted-foreground line-through"
                : "min-w-0 flex-1 truncate text-foreground/85"
            }
          >
            {item.title}
          </span>
          {row.badges.map((badge) => (
            <LedgerBadge key={badge.kind} badge={badge} />
          ))}
          <span className="sr-only">{ledgerItemStatusLabel(item)}</span>
        </CollapsibleTrigger>
        {/* Unfinished work shows its agents under the row; once opened, the detail lists them. */}
        {!open && row.agentsInline && row.agents.length > 0 ? (
          <div className="ps-4">
            <LedgerAgentLines lines={row.agents} context={context} />
          </div>
        ) : null}
        <CollapsiblePanel animate={false}>
          <LedgerItemDetail row={row} requiresJudge={requiresJudge} context={context} />
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

function LedgerRows({
  rows,
  requiresJudge,
  context,
}: {
  rows: ReadonlyArray<LedgerPanelRow>;
  requiresJudge: boolean;
  context: LedgerAgentContext;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {rows.map((row) => (
        <LedgerRow key={row.item.id} row={row} requiresJudge={requiresJudge} context={context} />
      ))}
    </ul>
  );
}

export function LedgerPanel({ threadRef, ledger }: { threadRef: ScopedThreadRef; ledger: Ledger }) {
  const records = useLedgerTaskRecords(threadRef);
  const providersByEnvironment = useEnvironmentProviders();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const panel = deriveLedgerPanel(ledger, records);
  const context: LedgerAgentContext = {
    environmentId: threadRef.environmentId,
    providers: providersByEnvironment.get(threadRef.environmentId),
    statsSupported:
      serverConfigs.get(threadRef.environmentId)?.environment.capabilities.taskStats === true,
    openThread: (threadId: ThreadId) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, threadId)),
      });
    },
  };
  const requiresJudge = ledger.requiresJudge === true;
  const { count } = panel;
  const hasGoal = ledger.startState.trim() !== "" || ledger.winConditions.length > 0;
  return (
    <div data-thread-ledger-panel className="flex flex-col gap-1 px-2.5 py-1">
      <div className="flex items-start justify-between gap-2">
        <p className="m-0 min-w-0 break-words text-sm font-semibold text-foreground/90">
          {ledger.title}
        </p>
        {ledger.closedAt === null ? null : (
          <Badge variant="secondary" size="sm">
            Closed
          </Badge>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        {count.total === 0 && count.dropped === 0 && count.deferred === 0 ? null : (
          <span className="shrink-0 text-base font-semibold whitespace-nowrap tabular-nums">
            {count.done} / {count.total}
          </span>
        )}
        <span className="min-w-0 text-xs text-muted-foreground">
          {formatLedgerPanelCount(count)}
        </span>
      </div>
      <div aria-hidden className="mb-1 h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full bg-success"
          style={{ width: `${Math.round(count.fraction * 100)}%` }}
        />
      </div>
      {hasGoal ? (
        <LedgerFold label="Goal and win conditions">
          <div className="flex flex-col gap-1.5 text-xs">
            {ledger.startState.trim() === "" ? null : (
              <p className="m-0 break-words text-muted-foreground">
                Started from: {ledger.startState}
              </p>
            )}
            {ledger.winConditions.length === 0 ? null : (
              <ul className="m-0 list-disc ps-4 text-foreground/85 marker:text-muted-foreground/60">
                {ledger.winConditions.map((entry, index) => (
                  // Win conditions are bare strings with no id; the list is replaced whole.
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={`${index}:${entry}`} className="break-words">
                    {entry}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </LedgerFold>
      ) : null}
      {panel.checkpoints.total === 0 ? null : (
        <LedgerFold label={`Checkpoints ${panel.checkpoints.reached} / ${panel.checkpoints.total}`}>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
            {ledger.checkpoints.map((checkpoint) => (
              <li key={checkpoint.id} className="flex items-start gap-2">
                {checkpoint.reached ? (
                  <CircleCheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : (
                  <CircleIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 break-words text-foreground/85">{checkpoint.title}</span>
                <span className="sr-only">{checkpoint.reached ? "reached" : "not reached"}</span>
              </li>
            ))}
          </ul>
        </LedgerFold>
      )}
      {panel.active.length === 0 ? null : (
        <div className="border-t border-border/70 pt-1.5">
          <LedgerRows rows={panel.active} requiresJudge={requiresJudge} context={context} />
        </div>
      )}
      {panel.done.length === 0 ? null : (
        <LedgerFold
          label={`Done · ${count.done}${count.dropped > 0 ? ` · ${count.dropped} dropped` : ""}`}
        >
          <LedgerRows rows={panel.done} requiresJudge={requiresJudge} context={context} />
        </LedgerFold>
      )}
      {panel.deferred.length === 0 ? null : (
        <LedgerFold label={`Deferred · ${panel.deferred.length}`}>
          <LedgerRows rows={panel.deferred} requiresJudge={requiresJudge} context={context} />
        </LedgerFold>
      )}
    </div>
  );
}
