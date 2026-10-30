// Fork: every agent delegated on the thread, with the ledger items each works on.
import type {
  Ledger,
  LedgerItemId,
  OrchestrationV2Subagent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { ledgerAgentStatus, sameTime, taskLabel, type LedgerAgentTone } from "./ledgerPanel.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

/** What the roster reads of a task: never its prompt or result. */
export type LedgerRosterRecord = Pick<
  OrchestrationV2Subagent,
  | "id"
  | "childThreadId"
  | "origin"
  | "role"
  | "serverJudge"
  | "title"
  | "model"
  | "providerInstanceId"
  | "status"
  | "startedAt"
  | "completedAt"
>;

export interface LedgerRosterRow {
  /** The subagent id. */
  readonly taskId: string;
  readonly childThreadId: ThreadId | null;
  /** The delegation's role, "judge" for the server's own judge, null when it named none. */
  readonly role: string | null;
  readonly judge: boolean;
  readonly native: boolean;
  /** The title less a leading "Role:", which the row already shows. */
  readonly label: string | null;
  readonly model: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly status: OrchestrationV2Subagent["status"];
  readonly tone: LedgerAgentTone;
  /** "running", or "done 1m 12s" once finished: nothing here depends on the clock. */
  readonly statusLabel: string;
  /** Items whose `tasks` link this task, then items it judges. */
  readonly itemIds: ReadonlyArray<LedgerItemId>;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}

export interface LedgerRoster {
  /** Pending, running and waiting agents, in start order. */
  readonly active: ReadonlyArray<LedgerRosterRow>;
  /** Everything else, the most recently finished first. */
  readonly finished: ReadonlyArray<LedgerRosterRow>;
  readonly counts: {
    readonly running: number;
    readonly done: number;
    readonly failed: number;
    readonly total: number;
  };
}

const EMPTY_ROSTER_RECORDS: ReadonlyArray<LedgerRosterRecord> = Object.freeze([]);

const millis = (time: DateTime.Utc | null) => (time === null ? null : DateTime.toEpochMillis(time));

// Array.prototype.sort is stable, so ties keep thread order. Unset times go last.
function byTime(
  key: (row: LedgerRosterRow) => DateTime.Utc | null,
  direction: "asc" | "desc",
): (left: LedgerRosterRow, right: LedgerRosterRow) => number {
  return (left, right) => {
    const a = millis(key(left));
    const b = millis(key(right));
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return direction === "asc" ? a - b : b - a;
  };
}

function linkedItemIds(ledger: Ledger | null): ReadonlyMap<string, Array<LedgerItemId>> {
  const byTask = new Map<string, Array<LedgerItemId>>();
  const add = (taskId: string, itemId: LedgerItemId) => {
    const ids = byTask.get(taskId);
    if (ids === undefined) byTask.set(taskId, [itemId]);
    else if (!ids.includes(itemId)) ids.push(itemId);
  };
  for (const item of ledger?.items ?? []) {
    for (const task of item.tasks ?? []) add(task.taskId, item.id);
    if (item.judgeTaskId !== undefined) add(item.judgeTaskId, item.id);
  }
  return byTask;
}

export function deriveLedgerAgentRoster(
  ledger: Ledger | null,
  records: ReadonlyArray<LedgerRosterRecord>,
): LedgerRoster {
  const items = linkedItemIds(ledger);
  const rows = records.map((record): LedgerRosterRow => {
    const judge = record.serverJudge === true || record.role === "judge";
    const role = record.role ?? (record.serverJudge === true ? "judge" : null);
    return {
      taskId: record.id,
      childThreadId: record.childThreadId,
      role,
      judge,
      native: record.origin === "provider_native",
      label: taskLabel(record.title, role ?? undefined),
      model: record.model,
      providerInstanceId: record.providerInstanceId,
      status: record.status,
      ...ledgerAgentStatus(record.status, record.startedAt, record.completedAt),
      itemIds: items.get(record.id) ?? [],
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    };
  });
  const active = rows
    .filter((row) => row.tone === "running")
    .sort(byTime((r) => r.startedAt, "asc"));
  const finished = rows
    .filter((row) => row.tone !== "running")
    .sort(byTime((r) => r.completedAt ?? r.startedAt, "desc"));
  return {
    active,
    finished,
    counts: {
      running: active.length,
      done: rows.filter((row) => row.tone === "done").length,
      failed: rows.filter((row) => row.tone === "failed").length,
      total: rows.length,
    },
  };
}

function sameRosterRecord(left: LedgerRosterRecord, right: LedgerRosterRecord): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.childThreadId === right.childThreadId &&
      left.origin === right.origin &&
      left.role === right.role &&
      left.serverJudge === right.serverJudge &&
      left.title === right.title &&
      left.model === right.model &&
      left.providerInstanceId === right.providerInstanceId &&
      left.status === right.status &&
      sameTime(left.startedAt, right.startedAt) &&
      sameTime(left.completedAt, right.completedAt))
  );
}

const pickRosterRecord = (subagent: OrchestrationV2Subagent): LedgerRosterRecord => ({
  id: subagent.id,
  childThreadId: subagent.childThreadId,
  origin: subagent.origin,
  role: subagent.role,
  ...(subagent.serverJudge === undefined ? {} : { serverJudge: subagent.serverJudge }),
  title: subagent.title,
  model: subagent.model,
  providerInstanceId: subagent.providerInstanceId,
  status: subagent.status,
  startedAt: subagent.startedAt,
  completedAt: subagent.completedAt,
});

/**
 * The thread's tasks as the roster reads them, holding their value through every update that
 * leaves them alone: streamed text and the progress strings of tasks.
 */
export function createLedgerRosterRecordsAtom(
  source: Atom.Atom<EnvironmentThreadState>,
): Atom.Atom<ReadonlyArray<LedgerRosterRecord>> {
  let subagents: ReadonlyArray<OrchestrationV2Subagent> | undefined;
  let value = EMPTY_ROSTER_RECORDS;
  return Atom.make((get) => {
    const next = Option.getOrNull(get(source).data)?.subagents;
    if (next === subagents) return value;
    subagents = next;
    const picked =
      next === undefined || next.length === 0 ? EMPTY_ROSTER_RECORDS : next.map(pickRosterRecord);
    const unchanged =
      picked.length === value.length &&
      picked.every((record, index) => sameRosterRecord(record, value[index]!));
    if (!unchanged) value = picked;
    return value;
  });
}
