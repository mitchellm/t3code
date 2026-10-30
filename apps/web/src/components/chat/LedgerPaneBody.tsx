/**
 * Fork: the ledger pane's content, written for the person watching the work. The agent's raw
 * evidence and judge notes are one click deeper; the first read is a headline and its facts.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  digestLedgerText,
  type LedgerDigest,
  type LedgerFact,
} from "@t3tools/client-runtime/state/ledger-digest";
import {
  deriveLedgerPanel,
  formatLedgerPanelCount,
  shortModelLabel,
  type LedgerPanelRow,
  type LedgerRowBadge,
} from "@t3tools/client-runtime/state/ledger-panel";
import {
  deriveLedgerAgentRoster,
  type LedgerRosterRow,
} from "@t3tools/client-runtime/state/ledger-roster";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { ledgerItemStatusLabel } from "@t3tools/client-runtime/state/thread-ledger";
import type { Ledger, LedgerItem, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  FileCodeIcon,
  GitCommitHorizontalIcon,
  GavelIcon,
  FlaskConicalIcon,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { useLedgerRosterRecords } from "~/hooks/useLedgerRosterRecords";
import { useLedgerTaskRecords } from "~/hooks/useLedgerTaskRecords";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { BuildModeBar } from "./BuildModeBar";
import { InvestigationPanel } from "./InvestigationPanel";
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

const SEGMENT_CLASS: Record<LedgerItem["status"], string> = {
  open: "bg-muted-foreground/25",
  in_progress: "bg-info",
  closed: "bg-success",
  dropped: "bg-muted-foreground/10",
  deferred: "bg-warning/50",
};

const TONE_DOT: Record<LedgerRosterRow["tone"], string> = {
  running: "bg-info",
  done: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/60",
  unknown: "bg-muted-foreground/40",
};

const TONE_TEXT: Record<LedgerRosterRow["tone"], string> = {
  running: "text-info",
  done: "text-success",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

// Sub-items indent under their parent; capped so a deep tree keeps room for its titles.
const DEPTH_INDENT = ["", "ps-5", "ps-10", "ps-14"] as const;
const indentFor = (depth: number) => DEPTH_INDENT[Math.min(depth, DEPTH_INDENT.length - 1)];

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

function RowBadge({ badge }: { badge: LedgerRowBadge }) {
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
        <Badge variant="outline" size="sm" title={`Waits for ${badge.blockedBy.join(", ")}`}>
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

const FACT_ICON: Record<LedgerFact["kind"], ComponentType<{ className?: string }>> = {
  commit: GitCommitHorizontalIcon,
  file: FileCodeIcon,
  tests: FlaskConicalIcon,
  pr: PullRequestGlyph.pullRequest,
};

function FactChip({ fact }: { fact: LedgerFact }) {
  const Icon = FACT_ICON[fact.kind];
  const chip = (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border/80 bg-background px-1.5 py-0.5 text-2xs",
        fact.kind === "commit" || fact.kind === "file" ? "font-mono" : undefined,
        fact.tone === "success" && "border-success/30 text-success",
        fact.tone === "error" && "border-destructive/30 text-destructive",
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0 opacity-70" />
      <span className="min-w-0 truncate">{fact.label}</span>
    </span>
  );
  // The chip shortens a path or SHA; the full value is a hover away.
  if (fact.value === fact.label) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" variant="code">
        {fact.value}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A headline and its facts first; the agent's full text on request. */
function DigestBlock({
  digest,
  raw,
  fullLabel,
}: {
  digest: LedgerDigest;
  raw: string;
  fullLabel: string;
}) {
  const [full, setFull] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      {full ? null : <p className="m-0 break-words text-foreground/90">{digest.headline}</p>}
      {full || digest.facts.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {digest.facts.map((fact) => (
            <FactChip key={`${fact.kind}:${fact.value}`} fact={fact} />
          ))}
          {digest.moreFacts > 0 ? (
            <span className="self-center text-2xs text-muted-foreground">
              +{digest.moreFacts} more
            </span>
          ) : null}
        </div>
      )}
      {full ? (
        <pre className="m-0 max-h-96 overflow-auto rounded-md border border-border/70 bg-background p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-foreground/85">
          {raw}
        </pre>
      ) : null}
      {digest.truncated || digest.facts.length > 0 || full ? (
        <Button
          variant="link"
          size="micro"
          className="self-start"
          aria-expanded={full}
          onClick={() => setFull(!full)}
        >
          {full ? "Show summary" : fullLabel}
        </Button>
      ) : null}
    </div>
  );
}

function judgeStatus(item: LedgerItem, requiresJudge: boolean): string | null {
  if (item.judging === true) {
    return item.setAside === undefined
      ? "Being judged now"
      : `Judging whether to ${item.setAside.status === "dropped" ? "drop" : "defer"} it`;
  }
  if (item.judgeError !== undefined) return `The judge did not finish: ${item.judgeError}`;
  if (item.verdict === null) {
    return requiresJudge && (item.status === "open" || item.status === "in_progress")
      ? "A judge checks it when the agent closes it"
      : null;
  }
  const tries = item.judgements ?? 0;
  if (item.verdict.outcome === "pass") {
    return tries > 1 ? `Judge passed it on try ${tries}` : "Judge passed it";
  }
  return tries > 1 ? `Judge sent it back (${tries} tries so far)` : "Judge sent it back";
}

function JudgeSection({
  item,
  requiresJudge,
  context,
}: {
  item: LedgerItem;
  requiresJudge: boolean;
  context: LedgerAgentContext;
}) {
  const status = judgeStatus(item, requiresJudge);
  if (status === null) return null;
  const verdict = item.verdict;
  const judgeProvider =
    verdict === null
      ? undefined
      : context.providers?.find((candidate) => candidate.instanceId === verdict.judge.instanceId);
  const judgeModel =
    verdict === null
      ? null
      : shortModelLabel(
          resolveSubagentMetadata({ model: verdict.judge.model, provider: judgeProvider })
            .modelLabel,
          judgeProvider?.displayName,
        );
  const digest = verdict === null ? null : digestLedgerText(verdict.notes);
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>Judge</SectionLabel>
      <p className="m-0 flex items-center gap-1.5">
        <GavelIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            verdict === null
              ? "text-muted-foreground"
              : verdict.outcome === "pass"
                ? "text-success"
                : "text-destructive",
          )}
        />
        <span className="min-w-0 break-words">{status}</span>
        {verdict === null ? null : (
          <span className="shrink-0 text-2xs text-muted-foreground">· {judgeModel}</span>
        )}
      </p>
      {verdict === null || digest === null ? null : (
        <DigestBlock digest={digest} raw={verdict.notes} fullLabel="Read the judge's full notes" />
      )}
    </div>
  );
}

function EvidenceSection({ item }: { item: LedgerItem }) {
  const digest = digestLedgerText(item.evidence);
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>What was done</SectionLabel>
      {digest === null || item.evidence === null ? (
        <p className="m-0 text-muted-foreground">
          {item.status === "closed" ? "Closed without evidence" : "Nothing recorded yet"}
        </p>
      ) : (
        <DigestBlock digest={digest} raw={item.evidence} fullLabel="Read the full evidence" />
      )}
    </div>
  );
}

function ItemDetail({
  row,
  requiresJudge,
  context,
}: {
  row: LedgerPanelRow;
  requiresJudge: boolean;
  context: LedgerAgentContext;
}) {
  const { item } = row;
  const setAsideReason = item.dropReason ?? item.deferReason ?? null;
  return (
    <div className="mt-1 mb-2 ms-6 flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/30 p-3 text-xs">
      <div className="flex flex-col gap-1">
        <SectionLabel>Done when</SectionLabel>
        <p className="m-0 break-words whitespace-pre-wrap text-foreground/90">
          {item.acceptance.trim() === "" ? (
            <span className="text-muted-foreground">Not written</span>
          ) : (
            item.acceptance
          )}
        </p>
      </div>
      {setAsideReason === null || setAsideReason.trim() === "" ? null : (
        <div className="flex flex-col gap-1">
          <SectionLabel>
            {item.status === "deferred" ? "Deferred because" : "Dropped because"}
          </SectionLabel>
          <p className="m-0 break-words text-foreground/90">{setAsideReason}</p>
        </div>
      )}
      {row.agents.length === 0 ? null : (
        <div className="flex flex-col gap-0.5">
          <SectionLabel>Agents on it</SectionLabel>
          <LedgerAgentLines lines={row.agents} context={context} />
        </div>
      )}
      <EvidenceSection item={item} />
      <JudgeSection item={item} requiresJudge={requiresJudge} context={context} />
    </div>
  );
}

function ItemRow({
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
        <CollapsibleTrigger className="group flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-panel-open:bg-accent/70">
          <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${iconClass}`} />
          <span className="mt-px w-7 shrink-0 font-mono text-2xs leading-5 text-muted-foreground">
            {item.id}
          </span>
          {/* Titles wrap rather than truncate: the point of the pane is to read them. */}
          <span
            className={cn(
              "min-w-0 flex-1 break-words",
              item.status === "dropped"
                ? "text-muted-foreground line-through"
                : item.status === "closed"
                  ? "text-foreground/70"
                  : "text-foreground",
            )}
          >
            {item.title}
          </span>
          {row.badges.length === 0 ? null : (
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {row.badges.map((badge) => (
                <RowBadge key={badge.kind} badge={badge} />
              ))}
            </span>
          )}
          <span className="sr-only">{ledgerItemStatusLabel(item)}</span>
        </CollapsibleTrigger>
        {!open && row.agentsInline && row.agents.length > 0 ? (
          <div className="ps-10">
            <LedgerAgentLines lines={row.agents} context={context} />
          </div>
        ) : null}
        <CollapsiblePanel animate={false}>
          <ItemDetail row={row} requiresJudge={requiresJudge} context={context} />
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

function ItemGroup({
  label,
  rows,
  requiresJudge,
  context,
  folded = false,
}: {
  label: string;
  rows: ReadonlyArray<LedgerPanelRow>;
  requiresJudge: boolean;
  context: LedgerAgentContext;
  folded?: boolean;
}) {
  if (rows.length === 0) return null;
  // A sub-item whose parent sits in another group starts at the margin, not under a gap.
  const inGroup = new Set<string>(rows.map((row) => row.item.id));
  const list = (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {rows.map((row) => (
        <ItemRow
          key={row.item.id}
          row={
            row.item.parentItemId === undefined || inGroup.has(row.item.parentItemId)
              ? row
              : { ...row, depth: 0 }
          }
          requiresJudge={requiresJudge}
          context={context}
        />
      ))}
    </ul>
  );
  const heading = (
    <>
      {label}
      <span className="tabular-nums text-muted-foreground/70">{rows.length}</span>
    </>
  );
  if (!folded) {
    return (
      <section className="flex flex-col gap-1">
        <p className="m-0 flex items-center gap-1.5 px-1.5 text-xs font-medium text-muted-foreground">
          {heading}
        </p>
        {list}
      </section>
    );
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon aria-hidden className="size-3.5 group-data-panel-open:rotate-90" />
        {heading}
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>{list}</CollapsiblePanel>
    </Collapsible>
  );
}

function LedgerOverview({
  ledger,
  panel,
}: {
  ledger: Ledger;
  panel: ReturnType<typeof deriveLedgerPanel>;
}) {
  const { count } = panel;
  const hasGoal = ledger.startState.trim() !== "" || ledger.winConditions.length > 0;
  // One segment per item in plan order, so the bar shows where the work is, not only how much.
  const segments = ledger.items.filter((item) => item.parentItemId === undefined);
  return (
    <div className="flex flex-col gap-2.5 px-3 pt-3">
      <div className="flex items-start gap-2">
        <h2 className="m-0 min-w-0 flex-1 break-words text-base leading-snug font-semibold text-foreground">
          {ledger.title}
        </h2>
        <Badge variant={ledger.closedAt === null ? "info" : "secondary"} size="sm">
          {ledger.closedAt === null ? "Active" : "Closed"}
        </Badge>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl leading-none font-semibold tabular-nums">
          {count.done}
          <span className="text-base text-muted-foreground"> / {count.total}</span>
        </span>
        <span className="min-w-0 text-xs text-muted-foreground">
          {formatLedgerPanelCount(count)}
        </span>
      </div>
      {segments.length === 0 ? null : (
        <div aria-hidden className="flex h-1.5 gap-0.5">
          {segments.map((item) => (
            <div
              key={item.id}
              className={cn("h-full flex-1 rounded-full", SEGMENT_CLASS[item.status])}
            />
          ))}
        </div>
      )}
      {ledger.checkpoints.length === 0 ? null : (
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {ledger.checkpoints.map((checkpoint) => (
            <li
              key={checkpoint.id}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-2xs",
                checkpoint.reached
                  ? "border-success/30 text-success"
                  : "border-border text-muted-foreground",
              )}
            >
              {checkpoint.reached ? (
                <CircleCheckIcon aria-hidden className="size-3 shrink-0" />
              ) : (
                <CircleIcon aria-hidden className="size-3 shrink-0" />
              )}
              <span className="min-w-0 break-words">{checkpoint.title}</span>
              <span className="sr-only">{checkpoint.reached ? "reached" : "not reached"}</span>
            </li>
          ))}
        </ol>
      )}
      {hasGoal ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon aria-hidden className="size-3.5 group-data-panel-open:rotate-90" />
            Goal and win conditions
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            <div className="mt-1.5 flex flex-col gap-1.5 rounded-lg bg-muted/30 p-2.5 text-xs">
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
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

function RosterRow({
  row,
  ledger,
  context,
}: {
  row: LedgerRosterRow;
  ledger: Ledger;
  context: LedgerAgentContext;
}) {
  const provider = context.providers?.find(
    (candidate) => candidate.instanceId === row.providerInstanceId,
  );
  const { modelLabel } = resolveSubagentMetadata({ model: row.model, provider });
  const role = row.judge ? "judge" : (row.role ?? (row.native ? "subagent" : "agent"));
  const childThreadId = row.childThreadId;
  const content = (
    <>
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[row.tone])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-sm font-medium text-foreground">{capitalize(role)}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {shortModelLabel(modelLabel, provider?.displayName)}
          </span>
          <span className={cn("ms-auto shrink-0 text-2xs whitespace-nowrap", TONE_TEXT[row.tone])}>
            {row.statusLabel}
          </span>
        </span>
        {row.label === null ? null : (
          <span className="break-words text-xs text-foreground/80">{row.label}</span>
        )}
        {row.itemIds.length === 0 ? null : (
          <span className="flex flex-wrap gap-1">
            {row.itemIds.map((itemId) => {
              const item = ledger.items.find((candidate) => candidate.id === itemId);
              return (
                <span
                  key={itemId}
                  className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
                >
                  <span className="shrink-0 font-mono">{itemId}</span>
                  {item === undefined ? null : (
                    <span className="min-w-0 truncate">{item.title}</span>
                  )}
                </span>
              );
            })}
          </span>
        )}
      </span>
      {childThreadId === null ? null : (
        <ArrowUpRightIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground/60" />
      )}
    </>
  );
  const className = "flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-left";
  return (
    <li>
      {childThreadId === null ? (
        <div className={className}>{content}</div>
      ) : (
        <button
          type="button"
          className={cn(
            className,
            "cursor-pointer hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          )}
          aria-label={`Open the ${role}'s thread`}
          onClick={() => context.openThread(childThreadId)}
        >
          {content}
        </button>
      )}
    </li>
  );
}

function AgentsView({
  ledger,
  threadRef,
  context,
}: {
  ledger: Ledger;
  threadRef: ScopedThreadRef;
  context: LedgerAgentContext;
}) {
  const records = useLedgerRosterRecords(threadRef);
  const roster = deriveLedgerAgentRoster(ledger, records);
  if (roster.counts.total === 0) {
    return (
      <p className="m-0 px-3 py-4 text-xs text-muted-foreground">
        No agents have been delegated on this thread. Work the planner does itself shows on the
        items.
      </p>
    );
  }
  const summary = [
    roster.counts.running > 0 ? `${roster.counts.running} working` : null,
    roster.counts.done > 0 ? `${roster.counts.done} done` : null,
    roster.counts.failed > 0 ? `${roster.counts.failed} failed` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const list = (rows: ReadonlyArray<LedgerRosterRow>) => (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {rows.map((row) => (
        <RosterRow key={row.taskId} row={row} ledger={ledger} context={context} />
      ))}
    </ul>
  );
  return (
    <div className="flex flex-col gap-3 px-1.5">
      <p className="m-0 px-1.5 text-xs text-muted-foreground">{summary}</p>
      {roster.active.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <p className="m-0 px-1.5 text-xs font-medium text-muted-foreground">Working now</p>
          {list(roster.active)}
        </section>
      )}
      {roster.finished.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <p className="m-0 px-1.5 text-xs font-medium text-muted-foreground">Finished</p>
          {list(roster.finished)}
        </section>
      )}
    </div>
  );
}

type PaneView = "items" | "agents";

export function LedgerPaneBody({
  threadRef,
  ledger,
}: {
  threadRef: ScopedThreadRef;
  ledger: Ledger;
}) {
  const [view, setView] = useState<PaneView>("items");
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
  const running = panel.active.filter((row) => row.item.status === "in_progress");
  const upNext = panel.active.filter((row) => row.item.status === "open");
  return (
    <div data-thread-ledger-panel className="flex flex-col gap-3 pb-4">
      <LedgerOverview ledger={ledger} panel={panel} />
      <InvestigationPanel threadRef={threadRef} ledger={ledger} />
      <div className="px-3">
        <ToggleGroup
          aria-label="Ledger view"
          value={[view]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "items" || next === "agents") setView(next);
          }}
        >
          <Toggle value="items">Items</Toggle>
          <Toggle value="agents">Agents</Toggle>
        </ToggleGroup>
      </div>
      {view === "agents" ? (
        <AgentsView ledger={ledger} threadRef={threadRef} context={context} />
      ) : (
        <div className="flex flex-col gap-3 px-1.5">
          <ItemGroup
            label="In progress"
            rows={running}
            requiresJudge={requiresJudge}
            context={context}
          />
          <ItemGroup
            label="Up next"
            rows={upNext}
            requiresJudge={requiresJudge}
            context={context}
          />
          <ItemGroup
            label="Done"
            rows={panel.done}
            requiresJudge={requiresJudge}
            context={context}
            folded={running.length + upNext.length > 0}
          />
          <ItemGroup
            label="Deferred"
            rows={panel.deferred}
            requiresJudge={requiresJudge}
            context={context}
            folded
          />
        </div>
      )}
      <BuildModeBar threadRef={threadRef} className="px-3" />
    </div>
  );
}
