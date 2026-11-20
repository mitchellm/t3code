import type {
  Ledger,
  LedgerItem,
  LedgerMcpSnapshot,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  orderLedgerTree,
  releasedLedgerItemIds,
  unreleasedBlockers,
} from "@t3tools/shared/taskLedger";

export type LedgerTaskStatusRecord = Pick<OrchestrationV2Subagent, "id" | "status">;

/**
 * Most characters a ledger tool result carries: the client refuses a result above about 25,000
 * tokens, and the JSON arrives twice (text and structuredContent). 2 x 30,000 characters is 24,000
 * tokens at the densest rate, 2.5 characters a token.
 */
const LEDGER_RESULT_MAX_CHARS = 30_000;

/** The shortest a free-text field of a listed item is cut to (title, acceptance, evidence, notes, reasons). */
const FIELD_CAP = 600;
/** Caps tried in turn for the unfinished items of a whole-ledger read: uncut first, then shorter until they fit. */
const READ_CAPS = [Number.POSITIVE_INFINITY, 4_000, 1_500, FIELD_CAP];
/** Newest linked tasks an item lists when the result is bounded; the rest are counted. */
const TASKS_SHOWN = 3;
/** One-line entries: the title, and the head of the evidence or reason. */
const BRIEF_TITLE_CAP = 60;
const BRIEF_HEAD_CAP = 80;
/** Room kept for one-line entries when deciding whether unfinished items can be shown in full. */
const BRIEFS_RESERVE = 5_000;
/** Room for the note that says what was left out, and the `briefs` key around the lines. */
const OMITTED_RESERVE = 600;
/** The judge's notes are the answer a judgement call exists to return, so they get more room. */
const JUDGEMENT_NOTES_CAP = 4_000;
/** Caps tried in turn for one item read alone: complete first, then cut until it fits. */
const ITEM_CAPS = [Number.POSITIVE_INFINITY, 8_000, 2_000, FIELD_CAP];

/**
 * Which items a ledger tool result lists. `read` is the whole ledger: unfinished items in full,
 * finished ones as one line each. `item` is one item complete. `changed` is a write's result: just
 * the items the call touched, and the goal only when `goal` is set (a new ledger).
 */
export type LedgerResultView =
  | { readonly kind: "read" }
  | { readonly kind: "item"; readonly itemId: string }
  | { readonly kind: "changed"; readonly itemIds: ReadonlyArray<string>; readonly goal?: boolean };

type SnapshotItem = LedgerMcpSnapshot["items"][number];

const measure = (value: unknown) => JSON.stringify(value).length;

const isUnfinished = ({ status }: LedgerItem) => status === "open" || status === "in_progress";

// Half an emoji would serialize to a lone surrogate escape, which provider JSON parsers reject.
const endBefore = (text: string, max: number) => {
  const last = text.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
};

/** The head of `text` up to `max` characters, ending in a marker that says how much went and where the rest is. */
function cut(text: string, max: number, rest?: string): string {
  if (text.length <= max) return text;
  const end = endBefore(text, max);
  return `${text.slice(0, end)} [+${text.length - end} chars cut${rest === undefined ? "" : `; ${rest}`}]`;
}

const restOf = (itemId: string) => `ledger_read itemId "${itemId}" has the rest`;

/** A judge's notes as a judgement result carries them; the item holds them whole. */
export const judgementNotes = (notes: string, itemId: string) =>
  cut(notes, JUDGEMENT_NOTES_CAP, restOf(itemId));

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

/** A head for a one-line entry: no marker, the line only points at the item. */
const lineHead = (text: string, max: number) => {
  const flat = oneLine(text);
  return flat.length <= max ? flat : `${flat.slice(0, endBefore(flat, max))}…`;
};

/** An item as one line: id, status, title, then what it waits on, or the head of its evidence or reason. */
function lineOf(item: LedgerItem, released: ReadonlySet<string>): string {
  const waiting = unreleasedBlockers(item, released);
  const why =
    item.status === "closed"
      ? item.evidence
      : item.status === "dropped"
        ? item.dropReason
        : item.status === "deferred"
          ? (item.deferReason ?? null)
          : null;
  const tail = [
    ...(waiting.length === 0 ? [] : [`waiting on ${waiting.join(", ")}`]),
    ...(why === null || oneLine(why) === "" ? [] : [why]),
  ];
  return `${item.id} ${item.judging === true ? `${item.status}, judging` : item.status}: ${lineHead(item.title, BRIEF_TITLE_CAP)}${tail
    .map((part) => ` | ${lineHead(part, BRIEF_HEAD_CAP)}`)
    .join("")}`;
}

/** Fork: the item's linked tasks, newest `shown`, with each one's status read live from the thread's tasks. */
function snapshotTasks(
  item: LedgerItem,
  statusOf: ReadonlyMap<string, OrchestrationV2Subagent["status"]>,
  shown: number,
) {
  const tasks = item.tasks ?? [];
  if (tasks.length === 0) return {};
  const kept = shown >= tasks.length ? tasks : tasks.slice(tasks.length - shown);
  return {
    tasks: kept.map((task) => ({
      taskId: task.taskId,
      role: task.role ?? null,
      model: task.model,
      status: statusOf.get(task.taskId) ?? null,
      childThreadId: task.childThreadId,
    })),
    ...(kept.length < tasks.length ? { tasksCut: tasks.length - kept.length } : {}),
  };
}

/** Fork: the thread's task records are read only when some item links a task. */
export const ledgerLinksTasks = (ledger: Ledger) =>
  ledger.items.some((item) => (item.tasks?.length ?? 0) > 0);

/**
 * The compact ledger view every ledger tool result carries, under `LEDGER_RESULT_MAX_CHARS`, with
 * items flat in tree order. `read` shows unfinished items cut to a head and finished ones as lines,
 * the oldest collapsing first; when unfinished items alone are too big they become lines too.
 * `item` shows one item complete, `changed` only what a write touched.
 */
export function snapshotLedger(
  ledger: Ledger,
  taskRecords: ReadonlyArray<LedgerTaskStatusRecord> = [],
  view: LedgerResultView = { kind: "read" },
): LedgerMcpSnapshot {
  const counts = { open: 0, in_progress: 0, closed: 0, dropped: 0, deferred: 0 };
  for (const item of ledger.items) counts[item.status] += 1;
  const released = releasedLedgerItemIds(ledger);
  const statusOf = new Map(taskRecords.map(({ id, status }) => [id as string, status]));
  const ordered = orderLedgerTree(ledger.items);
  const withGoal = view.kind !== "changed" || view.goal === true;
  const header = {
    ledgerId: ledger.id,
    title: cut(ledger.title, FIELD_CAP),
    ...(withGoal
      ? {
          startState: cut(ledger.startState, FIELD_CAP),
          winConditions: ledger.winConditions.map((condition) => cut(condition, FIELD_CAP)),
        }
      : {}),
    closed: ledger.closedAt !== null,
    requiresJudge: ledger.requiresJudge === true,
    ...(ledger.askCheck === true ? { askCheck: true as const } : {}),
    counts,
    unfinished: counts.open + counts.in_progress,
    checkpoints: ledger.checkpoints.map(({ id, title, reached }) => ({
      id,
      title: cut(title, FIELD_CAP),
      reached,
    })),
    ...(view.kind === "changed" ? { changedOnly: true as const } : {}),
    ...(view.kind === "item" ? { itemOnly: true as const } : {}),
  };

  const itemOf = (
    { item, depth }: { readonly item: LedgerItem; readonly depth: number },
    textCap: number,
    tasksShown: number,
    rest: string,
  ): SnapshotItem => {
    const text = (value: string) => cut(value, textCap, rest);
    const textOrNull = (value: string | null | undefined) =>
      value === null || value === undefined ? null : text(value);
    return {
      id: item.id,
      title: text(item.title),
      acceptance: text(item.acceptance),
      ...(item.quote === undefined ? {} : { quote: text(item.quote) }),
      status: item.status,
      depth,
      parentItemId: item.parentItemId ?? null,
      blockedBy: item.blockedBy ?? [],
      waitingOn: unreleasedBlockers(item, released),
      evidence: textOrNull(item.evidence),
      dropReason: textOrNull(item.dropReason),
      deferReason: textOrNull(item.deferReason),
      judging: item.judging === true,
      ...(item.setAside === undefined
        ? {}
        : { setAside: { status: item.setAside.status, reason: text(item.setAside.reason) } }),
      verdict: item.verdict?.outcome ?? null,
      verdictNotes: textOrNull(item.verdict?.notes),
      judgeError: textOrNull(item.judgeError),
      judgements: item.judgements ?? 0,
      ...snapshotTasks(item, statusOf, tasksShown),
    };
  };
  const assemble = (
    items: ReadonlyArray<SnapshotItem>,
    briefs: ReadonlyArray<string> = [],
    omitted: ReadonlyArray<string> = [],
  ): LedgerMcpSnapshot => ({
    ...header,
    items,
    ...(briefs.length === 0 ? {} : { briefs }),
    ...(omitted.length === 0 ? {} : { omitted: omitted.join(" ") }),
  });

  if (view.kind === "item") {
    const target = ordered.find(({ item }) => item.id === view.itemId);
    let snapshot = assemble([]);
    for (const cap of ITEM_CAPS) {
      snapshot = assemble(
        target === undefined
          ? []
          : [
              itemOf(
                target,
                cap,
                cap === Number.POSITIVE_INFINITY ? cap : TASKS_SHOWN,
                "more than one result can carry",
              ),
            ],
      );
      if (measure(snapshot) <= LEDGER_RESULT_MAX_CHARS) break;
    }
    return snapshot;
  }

  const shown = view.kind === "changed" ? new Set<string>(view.itemIds) : undefined;
  const listed = ordered.filter(({ item }) =>
    shown === undefined ? isUnfinished(item) : shown.has(item.id),
  );
  // Oldest first, as the ledger holds them; a write lists no finished items it did not change.
  const finished = shown === undefined ? ledger.items.filter((item) => !isUnfinished(item)) : [];
  // A read cuts only as far as it must: the agent acts on the acceptance line and the judge's notes.
  // A write's result always takes the short cap, since its caller just sent that text.
  const finishedLines = finished.map((item) => lineOf(item, released));
  const cost = (line: string) => measure(line) + 1;
  const finishedCost = finishedLines.reduce((sum, line) => sum + cost(line), 12);
  let full: ReadonlyArray<SnapshotItem> = [];
  let fitsFull = false;
  for (const cap of view.kind === "read" ? READ_CAPS : [FIELD_CAP]) {
    full = listed.map((entry) => itemOf(entry, cap, TASKS_SHOWN, restOf(entry.item.id)));
    // Longer text never pushes a finished line out: above the shortest cap every line must still fit.
    // At the shortest cap the items only leave a reserve, and the oldest lines collapse past it.
    const forLines = finished.length === 0 ? 0 : cap === FIELD_CAP ? BRIEFS_RESERVE : finishedCost;
    fitsFull = measure(assemble(full)) + forLines <= LEDGER_RESULT_MAX_CHARS;
    if (fitsFull) break;
  }

  const listedLines = fitsFull ? [] : listed.map(({ item }) => lineOf(item, released));
  const total = [...listedLines, ...finishedLines].reduce((sum, line) => sum + cost(line), 0);
  // 12 is the `,"briefs":[` and `]` that wrap the lines.
  let room = LEDGER_RESULT_MAX_CHARS - measure(assemble(fitsFull ? full : [])) - 12;
  if (!fitsFull || total > room) room -= OMITTED_RESERVE;
  // The longest prefix of `lines` that fits in `space`.
  const fit = (lines: ReadonlyArray<string>, space: number) => {
    let used = 0;
    let count = 0;
    for (const line of lines) {
      if (used + cost(line) > space) break;
      used += cost(line);
      count += 1;
    }
    return { count, used };
  };
  const listedFit = fit(listedLines, room);
  // Newest finished items stay; the oldest are the ones that collapse into a count.
  const finishedFit = fit(finishedLines.toReversed(), room - listedFit.used);
  const collapsed = finished.length - finishedFit.count;
  const leftOut = listed.length - listedFit.count;
  const range = (items: ReadonlyArray<{ readonly id: string }>) =>
    `${items[0]?.id} to ${items.at(-1)?.id}`;
  const omitted = [
    ...(collapsed === 0
      ? []
      : [
          `${collapsed} older finished items (${range(finished.slice(0, collapsed))}) are not listed; ledger_read with itemId shows any one.`,
        ]),
    ...(fitsFull || listed.length === 0
      ? []
      : [
          `${view.kind === "read" ? "Unfinished" : "Changed"} items are one line each because their full text would not fit; ledger_read with itemId shows any one.`,
        ]),
    ...(fitsFull || leftOut === 0
      ? []
      : [
          `${leftOut} of them (${range(listed.slice(listedFit.count).map(({ item }) => item))}) are not listed because even one line each would not fit.`,
        ]),
  ];
  return assemble(
    fitsFull ? full : [],
    [...listedLines.slice(0, listedFit.count), ...finishedLines.slice(collapsed)],
    omitted,
  );
}
