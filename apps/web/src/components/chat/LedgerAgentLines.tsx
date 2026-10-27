/** Fork: the agents linked to a ledger item, one line each, with a card read when it opens. */
import {
  deriveLedgerAgentCard,
  type LedgerAgentLine,
  type LedgerAgentTone,
} from "@t3tools/client-runtime/state/ledger-panel";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ServerProvider, ThreadId } from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

import { Button } from "../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";

export interface LedgerAgentContext {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  /** The server answers orchestration.getTaskStats. */
  readonly statsSupported: boolean;
  readonly openThread: (threadId: ThreadId) => void;
}

const TONE_TEXT: Record<LedgerAgentTone, string> = {
  running: "text-info",
  done: "text-success",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const TONE_DOT: Record<LedgerAgentTone, string> = {
  running: "bg-info",
  done: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/60",
  unknown: "bg-muted-foreground/40",
};

const LONG_PRESS_MS = 450;

/** Touch has no hover, so holding a line opens its card; the click that ends the hold is spent. */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        fired.current = false;
        cancel();
        if (event.pointerType !== "touch") return;
        timer.current = setTimeout(() => {
          timer.current = null;
          fired.current = true;
          onLongPress();
        }, LONG_PRESS_MS);
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onContextMenu: (event: MouseEvent<HTMLButtonElement>) => {
        if (fired.current || timer.current !== null) event.preventDefault();
      },
    },
    consumeLongPress: () => {
      const wasLongPress = fired.current;
      fired.current = false;
      return wasLongPress;
    },
  };
}

function agentRole(line: LedgerAgentLine): string {
  return line.task.role ?? "agent";
}

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CardStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-18 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 truncate tabular-nums">{children}</dd>
    </div>
  );
}

/** Mounted only while open: the stats are read and the time is taken once, here. */
function LedgerAgentCardBody({
  line,
  model,
  context,
}: {
  line: LedgerAgentLine;
  model: string;
  context: LedgerAgentContext;
}) {
  const [openedAtMs] = useState(() => Date.now());
  const stats = useEnvironmentQuery(
    context.statsSupported
      ? orchestrationEnvironment.taskStats({
          environmentId: context.environmentId,
          input: { threadId: line.task.childThreadId },
        })
      : null,
  );
  const card = deriveLedgerAgentCard(line, stats.data, openedAtMs);
  const waiting = context.statsSupported && stats.data === null && stats.error === null;
  const unknown = waiting ? "…" : "-";
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-sm font-semibold">{agentRole(line)}</span>
        {line.title === null ? null : (
          <span className="min-w-0 truncate text-muted-foreground">{line.title}</span>
        )}
      </div>
      <dl className="m-0 flex flex-col gap-1">
        <CardStat label="Model">{model}</CardStat>
        <CardStat label="Status">
          <span className={TONE_TEXT[card.tone]}>{card.status}</span>
        </CardStat>
        <CardStat label="Time">
          {card.time === null
            ? "Not started"
            : card.time.running
              ? `${card.time.label} · since ${formatClockTime(card.time.startedAtMs)}`
              : `${card.time.label} total`}
        </CardStat>
        <CardStat label="Tokens">{card.tokens ?? (waiting ? "…" : "Not reported")}</CardStat>
        <CardStat label="Tool calls">{card.toolCalls ?? unknown}</CardStat>
        <CardStat label={card.workspace?.label ?? "Worktree"}>
          {card.workspace?.value ?? unknown}
        </CardStat>
      </dl>
      {card.activity === null ? null : (
        <p className="m-0 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-2xs">
          {card.activity}
        </p>
      )}
      {stats.error === null ? null : (
        <p className="m-0 text-muted-foreground">Stats are unavailable: {stats.error}</p>
      )}
      <p className="m-0 text-2xs text-muted-foreground">Click to open this agent's session</p>
    </div>
  );
}

function LedgerAgentReport({
  line,
  onOpenThread,
}: {
  line: LedgerAgentLine & { readonly report: string };
  onOpenThread: () => void;
}) {
  const role = agentRole(line);
  return (
    <div className="mt-0.5 mb-1 ms-4 flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs">
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span>
          {role.charAt(0).toUpperCase()}
          {role.slice(1)} report
        </span>
        <Button variant="link" size="micro" onClick={onOpenThread}>
          Open thread
          <ArrowUpRightIcon aria-hidden />
        </Button>
      </div>
      <p className="m-0 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-foreground/85">
        {line.report}
      </p>
    </div>
  );
}

function LedgerAgentLineRow({
  line,
  last,
  context,
}: {
  line: LedgerAgentLine;
  last: boolean;
  context: LedgerAgentContext;
}) {
  const [cardOpen, setCardOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const longPress = useLongPress(() => setCardOpen(true));
  const provider = context.providers?.find(
    (candidate) => candidate.instanceId === line.task.providerInstanceId,
  );
  const { modelLabel } = resolveSubagentMetadata({ model: line.task.model, provider });
  const effort =
    line.modelSelection === undefined
      ? null
      : formatModelSelectionEffort(line.modelSelection, provider?.models ?? []);
  const openThread = () => context.openThread(line.task.childThreadId);
  const report = line.report;
  return (
    <li className="flex flex-col">
      <div className="flex min-w-0 items-center gap-1">
        <PreviewCard open={cardOpen} onOpenChange={setCardOpen}>
          <PreviewCardTrigger
            delay={300}
            closeDelay={100}
            render={
              <button
                type="button"
                {...longPress.handlers}
                onClick={(event) => {
                  if (longPress.consumeLongPress()) {
                    event.preventDefault();
                    return;
                  }
                  openThread();
                }}
                className="group flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-md py-1 ps-1 pe-1.5 text-left text-xs hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent/60"
              />
            }
          >
            <span aria-hidden className="w-3 shrink-0 font-mono text-muted-foreground/50">
              {last ? "└" : "├"}
            </span>
            <span className="w-16 shrink-0 truncate font-medium text-foreground/90">
              {agentRole(line)}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {modelLabel}
              {line.title === null ? null : ` · ${line.title}`}
            </span>
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-2xs ${TONE_TEXT[line.tone]}`}
            >
              <span aria-hidden className={`size-1.5 rounded-full ${TONE_DOT[line.tone]}`} />
              {line.statusLabel}
            </span>
            <ArrowUpRightIcon
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100"
            />
          </PreviewCardTrigger>
          {cardOpen ? (
            <PreviewCardPopup side="left" align="start" className="w-72">
              <LedgerAgentCardBody
                line={line}
                model={effort === null ? modelLabel : `${modelLabel} · ${effort}`}
                context={context}
              />
            </PreviewCardPopup>
          ) : null}
        </PreviewCard>
        {report === null ? null : (
          <Button
            variant="ghost-muted"
            size="micro"
            aria-expanded={reportOpen}
            onClick={() => setReportOpen(!reportOpen)}
          >
            <ChevronRightIcon aria-hidden className={reportOpen ? "rotate-90" : undefined} />
            Report
          </Button>
        )}
      </div>
      {reportOpen && report !== null ? (
        <LedgerAgentReport line={{ ...line, report }} onOpenThread={openThread} />
      ) : null}
    </li>
  );
}

export function LedgerAgentLines({
  lines,
  context,
}: {
  lines: ReadonlyArray<LedgerAgentLine>;
  context: LedgerAgentContext;
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {lines.map((line, index) => (
        <LedgerAgentLineRow
          key={line.task.taskId}
          line={line}
          last={index === lines.length - 1}
          context={context}
        />
      ))}
    </ul>
  );
}
