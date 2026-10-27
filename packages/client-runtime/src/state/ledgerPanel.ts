// Fork: the ledger panel's layout and its agent lines, pure over the ledger and the linked tasks.
import {
  isOrchestrationV2WorkActive,
  type Ledger,
  type LedgerItem,
  type LedgerItemTask,
  type OrchestrationV2Subagent,
  type TaskStats,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  orderLedgerTree,
  releasedLedgerItemIds,
  unreleasedBlockers,
} from "@t3tools/shared/taskLedger";
import { formatTokens } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { deriveLedgerItemTasks, deriveLedgerProgress } from "./threadLedger.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

/** What the panel reads of a linked task: its live state on the thread, never its prompt. */
export type LedgerTaskRecord = Pick<
  OrchestrationV2Subagent,
  "id" | "status" | "result" | "title" | "startedAt" | "completedAt" | "modelSelection"
>;

export type LedgerAgentTone = "running" | "done" | "failed" | "stopped" | "unknown";

export interface LedgerAgentLine {
  readonly task: LedgerItemTask;
  readonly status: OrchestrationV2Subagent["status"] | null;
  readonly tone: LedgerAgentTone;
  /** "running", or "done 1m 12s" once finished: nothing here depends on the clock. */
  readonly statusLabel: string;
  readonly report: string | null;
  readonly title: string | null;
  readonly modelSelection: OrchestrationV2Subagent["modelSelection"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}

export type LedgerRowBadge =
  | { readonly kind: "judging"; readonly label: string }
  | { readonly kind: "passed"; readonly label: string }
  | { readonly kind: "failed"; readonly label: string }
  | {
      readonly kind: "blocked";
      readonly label: string;
      readonly blockedBy: ReadonlyArray<LedgerItem["id"]>;
    }
  | { readonly kind: "agents"; readonly label: string; readonly running: boolean };

export interface LedgerPanelRow {
  readonly item: LedgerItem;
  /** Nesting within the row's group; 0 for a top-level item. */
  readonly depth: number;
  readonly badges: ReadonlyArray<LedgerRowBadge>;
  readonly agents: ReadonlyArray<LedgerAgentLine>;
  /** Unfinished items list their agents under the row; finished ones fold to the count badge. */
  readonly agentsInline: boolean;
}

export interface LedgerPanelCount {
  readonly done: number;
  /** Items in scope: dropped and deferred ones are out. */
  readonly total: number;
  readonly fraction: number;
  /** In-scope items added after the ledger was written. */
  readonly addedSincePlan: number;
  readonly dropped: number;
  readonly deferred: number;
}

export interface LedgerPanel {
  readonly count: LedgerPanelCount;
  readonly checkpoints: { readonly reached: number; readonly total: number };
  /** Open and in-progress items, each parent followed by its sub-items. */
  readonly active: ReadonlyArray<LedgerPanelRow>;
  /** Closed and dropped items, folded by default. */
  readonly done: ReadonlyArray<LedgerPanelRow>;
  readonly deferred: ReadonlyArray<LedgerPanelRow>;
}

const AGENT_STATUS: Record<
  OrchestrationV2Subagent["status"],
  { readonly label: string; readonly tone: LedgerAgentTone }
> = {
  pending: { label: "starting", tone: "running" },
  running: { label: "running", tone: "running" },
  waiting: { label: "waiting", tone: "running" },
  idle: { label: "idle", tone: "stopped" },
  completed: { label: "done", tone: "done" },
  failed: { label: "failed", tone: "failed" },
  cancelled: { label: "cancelled", tone: "stopped" },
  interrupted: { label: "stopped", tone: "stopped" },
};
const UNKNOWN_STATUS = { label: "unknown", tone: "unknown" } as const;

const isUnfinished = (item: LedgerItem) => item.status === "open" || item.status === "in_progress";
const isFinished = (item: LedgerItem) => item.status === "closed" || item.status === "dropped";
const isInScope = (item: LedgerItem) => item.status !== "dropped" && item.status !== "deferred";

const elapsedMs = (from: DateTime.Utc, to: DateTime.Utc) =>
  Math.max(0, DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from));

function agentLine(
  row: ReturnType<typeof deriveLedgerItemTasks>[number],
  record: LedgerTaskRecord | undefined,
): LedgerAgentLine {
  const { label, tone } = row.status === null ? UNKNOWN_STATUS : AGENT_STATUS[row.status];
  const finishedIn =
    tone === "done" && row.startedAt !== null && row.completedAt !== null
      ? formatDuration(elapsedMs(row.startedAt, row.completedAt))
      : null;
  return {
    task: row.task,
    status: row.status,
    tone,
    statusLabel: finishedIn === null ? label : `${label} ${finishedIn}`,
    report: row.report,
    title: record?.title ?? null,
    modelSelection: record?.modelSelection,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

/** Failing verdicts since the item was last reopened or passed; null when the record predates the count. */
function failuresSinceReopen(item: LedgerItem): number | null {
  if (item.judgements === undefined) return null;
  return Math.max(0, item.judgements - (item.judgementsAtReopen ?? 0));
}

function verdictBadge(item: LedgerItem): LedgerRowBadge | null {
  if (item.judging === true) return { kind: "judging", label: "judging" };
  if (item.verdict === null) return null;
  if (item.verdict.outcome === "pass") return { kind: "passed", label: "passed" };
  const failures = failuresSinceReopen(item);
  // A failure from before the item was reopened is history, not its state now.
  if (failures === 0) return null;
  return { kind: "failed", label: failures === null ? "failed" : `failed ${failures}×` };
}

function rowBadges(
  item: LedgerItem,
  released: ReadonlySet<string>,
  agents: ReadonlyArray<LedgerAgentLine>,
): ReadonlyArray<LedgerRowBadge> {
  const badges: Array<LedgerRowBadge> = [];
  const verdict = verdictBadge(item);
  if (verdict !== null) badges.push(verdict);
  // A blocker only matters before the item starts or closes.
  const blockedBy = isUnfinished(item) ? unreleasedBlockers(item, released) : [];
  if (blockedBy.length > 0) {
    badges.push({
      kind: "blocked",
      label:
        blockedBy.length === 1
          ? `after ${blockedBy[0]}`
          : `after ${blockedBy[0]} +${blockedBy.length - 1}`,
      blockedBy,
    });
  }
  if (agents.length > 0) {
    badges.push({
      kind: "agents",
      label: agents.length === 1 ? "1 agent" : `${agents.length} agents`,
      running: agents.some((line) => line.tone === "running"),
    });
  }
  return badges;
}

export function deriveLedgerPanel(
  ledger: Ledger,
  records: ReadonlyArray<LedgerTaskRecord>,
): LedgerPanel {
  const progress = deriveLedgerProgress(ledger);
  const released = releasedLedgerItemIds(ledger);
  const recordsById = new Map(records.map((record) => [record.id as string, record]));
  const planWrittenMs = DateTime.toEpochMillis(ledger.createdAt);
  const addedSincePlan = ledger.items.filter(
    (item) => isInScope(item) && DateTime.toEpochMillis(item.createdAt) > planWrittenMs,
  ).length;

  const toRow = ({ item, depth }: { item: LedgerItem; depth: number }): LedgerPanelRow => {
    const agents = deriveLedgerItemTasks(item, records).map((row) =>
      agentLine(row, recordsById.get(row.task.taskId)),
    );
    return {
      item,
      depth,
      badges: rowBadges(item, released, agents),
      agents,
      agentsInline: isUnfinished(item),
    };
  };
  const group = (keep: (item: LedgerItem) => boolean) =>
    orderLedgerTree(ledger.items.filter(keep)).map(toRow);

  return {
    count: {
      done: progress.closed,
      total: progress.scope,
      fraction: progress.scope === 0 ? 0 : progress.closed / progress.scope,
      addedSincePlan,
      dropped: progress.dropped,
      deferred: progress.deferred,
    },
    checkpoints: {
      reached: ledger.checkpoints.filter((checkpoint) => checkpoint.reached).length,
      total: ledger.checkpoints.length,
    },
    active: group(isUnfinished),
    done: group(isFinished),
    deferred: group((item) => item.status === "deferred"),
  };
}

/** The words after the "done / total" figure. */
export function formatLedgerPanelCount(count: LedgerPanelCount): string {
  if (count.total === 0 && count.dropped === 0 && count.deferred === 0) return "No items yet";
  return [
    "done",
    count.addedSincePlan > 0 ? `${count.addedSincePlan} added since the plan` : null,
    count.deferred > 0 ? `${count.deferred} deferred` : null,
    count.dropped > 0 ? `${count.dropped} dropped` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export interface LedgerAgentCard {
  readonly status: string;
  readonly tone: LedgerAgentTone;
  /** Running time up to when the card opened, or the total once finished. */
  readonly time: {
    readonly label: string;
    readonly running: boolean;
    readonly startedAtMs: number;
  } | null;
  readonly tokens: string | null;
  readonly toolCalls: number | null;
  /** Only while the task runs. */
  readonly activity: string | null;
  readonly workspace: { readonly label: "Worktree" | "Branch"; readonly value: string } | null;
}

/**
 * The agent card, computed once when it opens. `stats` is null until the server answers; the
 * fields the client already holds show in the meantime.
 */
export function deriveLedgerAgentCard(
  line: LedgerAgentLine,
  stats: TaskStats | null,
  openedAtMs: number,
): LedgerAgentCard {
  const running = line.status !== null && isOrchestrationV2WorkActive(line.status);
  const startedAtMs = line.startedAt === null ? null : DateTime.toEpochMillis(line.startedAt);
  const endMs = running
    ? openedAtMs
    : line.completedAt === null
      ? null
      : DateTime.toEpochMillis(line.completedAt);
  const statusLabel = line.status === null ? UNKNOWN_STATUS.label : AGENT_STATUS[line.status].label;
  return {
    status: `${statusLabel.charAt(0).toUpperCase()}${statusLabel.slice(1)}`,
    tone: line.tone,
    time:
      startedAtMs === null || endMs === null
        ? null
        : {
            label: formatDuration(Math.max(0, endMs - startedAtMs)),
            running,
            startedAtMs,
          },
    tokens:
      stats?.tokens == null
        ? null
        : `${formatTokens(stats.tokens.input + stats.tokens.output)} · ${formatTokens(stats.tokens.input)} in, ${formatTokens(stats.tokens.output)} out`,
    toolCalls: stats?.toolCalls ?? null,
    activity: running ? (stats?.activity ?? null) : null,
    workspace:
      stats == null
        ? null
        : stats.worktreePath !== null
          ? { label: "Worktree", value: stats.branch ?? stats.worktreePath }
          : stats.branch !== null
            ? { label: "Branch", value: stats.branch }
            : null,
  };
}

const EMPTY_TASK_RECORDS: ReadonlyArray<LedgerTaskRecord> = Object.freeze([]);

const sameTime = (left: DateTime.Utc | null, right: DateTime.Utc | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right));

function sameRecord(left: LedgerTaskRecord, right: LedgerTaskRecord): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.status === right.status &&
      left.result === right.result &&
      left.title === right.title &&
      sameTime(left.startedAt, right.startedAt) &&
      sameTime(left.completedAt, right.completedAt) &&
      (left.modelSelection === right.modelSelection ||
        JSON.stringify(left.modelSelection) === JSON.stringify(right.modelSelection)))
  );
}

/** The thread's task records that some ledger item links, in thread order. */
function selectLedgerTaskRecords(
  ledger: Ledger | undefined,
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlyArray<LedgerTaskRecord> {
  const linked = new Set<string>();
  for (const item of ledger?.items ?? []) {
    for (const task of item.tasks ?? []) linked.add(task.taskId);
  }
  return linked.size === 0
    ? EMPTY_TASK_RECORDS
    : subagents.filter((subagent) => linked.has(subagent.id));
}

/**
 * The linked task records, holding their value through every update that leaves them alone: the
 * streamed text of the thread and the progress of tasks no item links.
 */
export function createLedgerTaskRecordsAtom(
  source: Atom.Atom<EnvironmentThreadState>,
): Atom.Atom<ReadonlyArray<LedgerTaskRecord>> {
  let ledger: Ledger | undefined;
  let subagents: ReadonlyArray<OrchestrationV2Subagent> | undefined;
  let value = EMPTY_TASK_RECORDS;
  return Atom.make((get) => {
    const projection = Option.getOrNull(get(source).data);
    if (projection?.ledger === ledger && projection?.subagents === subagents) return value;
    ledger = projection?.ledger;
    subagents = projection?.subagents;
    const next = selectLedgerTaskRecords(ledger, subagents ?? []);
    const unchanged =
      next.length === value.length &&
      next.every((record, index) => sameRecord(record, value[index]!));
    if (!unchanged) value = next;
    return value;
  });
}
