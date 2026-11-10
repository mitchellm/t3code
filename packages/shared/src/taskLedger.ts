import type {
  Ledger,
  LedgerItem,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";

/** Consecutive server follow-ups per thread before it stops and waits for the user. */
export const LEDGER_AUTO_CONTINUE_CAP = 5;

/**
 * Fork: a reply that asks the user something ends on their answer, not on more ledger work.
 * Agents lead with the question (or end on it), so the first and last lines are what count.
 */
export function asksTheUser(message: string | undefined): boolean {
  const lines = (message ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const isQuestion = (line: string | undefined) =>
    line !== undefined && /\?[\s*_`"')\]]*$/u.test(line);
  return isQuestion(lines[0]) || isQuestion(lines.at(-1));
}

// Quotes are compared on words alone, so smart quotes, markdown and line breaks the agent tidied
// away do not make a faithful quote look invented.
const quoteWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, " ")
    .trim();

/**
 * Fork: the first item whose quote is not in anything the user wrote, so an agent cannot make up
 * one of the user's asks. Undefined when every quote is found.
 */
export function unquotedAsk<Item extends { readonly id: string; readonly quote?: string }>(
  items: ReadonlyArray<Item>,
  userTexts: ReadonlyArray<string>,
): Item | undefined {
  const said = userTexts.map(quoteWords);
  return items.find((item) => {
    if (item.quote === undefined) return false;
    const words = quoteWords(item.quote);
    return words === "" || !said.some((text) => text.includes(words));
  });
}

export type LedgerAutoContinueDecision =
  | { readonly type: "idle" }
  | {
      readonly type: "continue";
      readonly round: number;
      readonly open: ReadonlyArray<LedgerItem>;
      readonly items: ReadonlyArray<LedgerProgressMark>;
    }
  | {
      readonly type: "stuck";
      readonly reason: "cap" | "stalled";
      readonly openIds: ReadonlyArray<LedgerItem["id"]>;
    };

type LedgerContinueMessage = Pick<
  OrchestrationV2ConversationMessage,
  "role" | "createdBy" | "creationSource" | "notification"
> & { readonly runId?: OrchestrationV2ConversationMessage["runId"] };

const isOpen = (item: Pick<LedgerItem, "status">) =>
  item.status === "open" || item.status === "in_progress";

/**
 * A round of the follow-up streak. The set-aside hint is a ledger_continue message too, but it is
 * one-shot information, not a round: it neither counts toward the cap nor stands as the snapshot
 * the next round is compared with.
 */
export const isLedgerFollowUpRound = (message: LedgerContinueMessage): boolean =>
  message.notification?.source.kind === "ledger_continue" &&
  message.notification.source.setAsideHint === undefined;

/** What a follow-up records per item; a judge's hand-back changes it without a status change. */
export type LedgerProgressMark = Pick<LedgerItem, "id" | "status" | "judging" | "judgements">;

const markOf = (item: LedgerProgressMark) =>
  `${item.id}:${item.status}:${item.judging === true}:${item.judgements ?? 0}`;

const signatureOf = (items: ReadonlyArray<LedgerProgressMark>) =>
  items.map(markOf).sort().join("\n");

export const progressMark = ({
  id,
  status,
  judging,
  judgements,
}: LedgerItem): LedgerProgressMark => ({
  id,
  status,
  ...(judging === true ? { judging } : {}),
  ...(judgements === undefined ? {} : { judgements }),
});

/**
 * What the judge rules on: a pending drop or defer's reason, else the evidence offered for a
 * close. A verdict is recorded against it, so a claim changed while judging voids the verdict.
 */
export const judgedClaim = (item: Pick<LedgerItem, "setAside" | "evidence">): string | null =>
  item.setAside?.reason ?? item.evidence;

/**
 * An open ledger whose every item is closed, dropped or deferred: a new ledger or investigation
 * closes it instead of being refused, so finished work does not strand the thread's next task.
 * A running investigation keeps its own ledger until it ends.
 */
export const isFinishedOpenLedger = (ledger: Ledger): boolean =>
  ledger.closedAt === null &&
  ledger.investigation?.status !== "running" &&
  !ledger.items.some(isOpen);

/** Whether an item open when `snapshot` was taken has since been closed, dropped or deferred. */
export function finishedSince(
  snapshot: ReadonlyArray<Pick<LedgerItem, "id" | "status">>,
  current: ReadonlyArray<Pick<LedgerItem, "id" | "status">>,
): boolean {
  const finishedThen = new Set(snapshot.filter((item) => !isOpen(item)).map(({ id }) => id));
  return current.some((item) => !isOpen(item) && !finishedThen.has(item.id));
}

/**
 * Each follow-up records its round and the item statuses it was sent against, so the streak
 * since the user last spoke (chronological `messages`; server wakes neither count nor reset it)
 * is both counter and progress check. A follow-up in `cancelledRunIds` was declined: stay quiet.
 */
export function decideLedgerAutoContinue(input: {
  readonly ledger: Ledger | undefined;
  readonly messages: ReadonlyArray<LedgerContinueMessage>;
  readonly cancelledRunIds?: ReadonlySet<string>;
}): LedgerAutoContinueDecision {
  const { ledger } = input;
  if (ledger === undefined || ledger.closedAt !== null) return { type: "idle" };
  const open = ledger.items.filter(isOpen);
  if (open.length === 0) return { type: "idle" };

  let streak = 0;
  let counting = true;
  let previous: ReadonlyArray<LedgerProgressMark> | undefined;
  let userIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (message.role !== "user") continue;
    if (
      message.notification?.source.kind === "ledger_continue" &&
      !isLedgerFollowUpRound(message)
    ) {
      continue;
    }
    if (message.notification?.source.kind === "ledger_continue") {
      if (message.runId != null && input.cancelledRunIds?.has(message.runId) === true) {
        return { type: "idle" };
      }
      // The cap bounds rounds that finish nothing; a delegate or judge wake that closed an item
      // since an older round is real progress, so rounds before it no longer count.
      counting &&= !finishedSince(message.notification.source.items, ledger.items);
      if (counting) streak += 1;
      previous ??= message.notification.source.items;
    } else if (message.createdBy === "user" && message.creationSource !== "server") {
      userIndex = index;
      break;
    }
  }

  const items = ledger.items.map(progressMark);
  // The user spoke but their turn left the ledger exactly as the last follow-up found it, which is
  // how a ledger waiting on the user looks (an item blocked on something only they have).
  // Restarting follow-ups would only produce more "still waiting on you" turns; any ledger change
  // starts them again.
  if (previous === undefined && userIndex > 0) {
    const before = input.messages.slice(0, userIndex).findLast(isLedgerFollowUpRound);
    if (
      before?.notification?.source.kind === "ledger_continue" &&
      signatureOf(before.notification.source.items) === signatureOf(items)
    ) {
      return { type: "idle" };
    }
  }
  // A stalled replan that changed nothing showed these items need someone else: once a later wake
  // finds every open item exactly as that replan did, more rounds would only say "still waiting".
  // A replan that moved things still continues, and a plain follow-up after it ends that stall, so
  // a new one earns its own replan.
  const latestFollowUp = input.messages.findLast(isLedgerFollowUpRound);
  const stalledReplan =
    latestFollowUp?.notification?.source.kind === "ledger_continue" &&
    latestFollowUp.notification.source.replan?.reason === "stalled"
      ? latestFollowUp
      : undefined;
  if (
    stalledReplan !== undefined &&
    stalledReplan !== input.messages.at(-1) &&
    stalledReplan.notification?.source.kind === "ledger_continue"
  ) {
    const stalledMarks = new Set(stalledReplan.notification.source.items.map(markOf));
    if (open.every((item) => stalledMarks.has(markOf(progressMark(item))))) {
      return { type: "idle" };
    }
  }
  if (streak >= LEDGER_AUTO_CONTINUE_CAP) {
    return { type: "stuck", reason: "cap", openIds: open.map((item) => item.id) };
  }
  if (previous !== undefined && signatureOf(previous) === signatureOf(items)) {
    return { type: "stuck", reason: "stalled", openIds: open.map((item) => item.id) };
  }
  return { type: "continue", round: streak + 1, open, items };
}

/**
 * Items in tree order: each parent followed by its sub-items, depth first, ledger order among
 * siblings. A sub-item whose parent is not in `items` is lifted to the top level. Linear in items,
 * because ledgers reach thousands; iterative, so a deep chain cannot overflow the stack.
 */
export function orderLedgerTree(
  items: ReadonlyArray<LedgerItem>,
): ReadonlyArray<{ readonly item: LedgerItem; readonly depth: number }> {
  const present = new Set<string>(items.map((item) => item.id));
  const roots: Array<LedgerItem> = [];
  const children = new Map<string, Array<LedgerItem>>();
  for (const item of items) {
    const parent = item.parentItemId;
    if (parent === undefined || !present.has(parent)) {
      roots.push(item);
      continue;
    }
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [item]);
    else siblings.push(item);
  }
  const ordered: Array<{ item: LedgerItem; depth: number }> = [];
  // The planner rejects parent cycles; `placed` still keeps a corrupt record from looping.
  const placed = new Set<string>();
  const stack = [...roots].reverse().map((item) => ({ item, depth: 0 }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (placed.has(entry.item.id)) continue;
    placed.add(entry.item.id);
    ordered.push(entry);
    const below = children.get(entry.item.id) ?? [];
    for (let index = below.length - 1; index >= 0; index -= 1) {
      stack.push({ item: below[index]!, depth: entry.depth + 1 });
    }
  }
  return ordered;
}

/** Ids of blockers that are not closed or dropped yet. */
export function unreleasedBlockers(
  item: LedgerItem,
  released: ReadonlySet<string>,
): ReadonlyArray<LedgerItem["id"]> {
  return (item.blockedBy ?? []).filter((id) => !released.has(id));
}

/** Items that release their dependents: closed or dropped. */
export function releasedLedgerItemIds(ledger: Ledger): ReadonlySet<string> {
  return new Set(
    ledger.items
      .filter((item) => item.status === "closed" || item.status === "dropped")
      .map((item) => item.id),
  );
}

export interface LedgerFollowUpItem {
  readonly item: LedgerItem;
  /** Blockers not yet closed or dropped. */
  readonly waitingOn: ReadonlyArray<LedgerItem["id"]>;
}

/**
 * Splits unfinished items into what the agent can work on now and what waits on a blocker or on
 * the server's judge, keeping ledger order inside each group.
 */
export function partitionLedgerFollowUp(
  ledger: Ledger,
  unfinished: ReadonlyArray<LedgerItem>,
): {
  readonly actionable: ReadonlyArray<LedgerFollowUpItem>;
  readonly waiting: ReadonlyArray<LedgerFollowUpItem>;
} {
  const released = releasedLedgerItemIds(ledger);
  const actionable: Array<LedgerFollowUpItem> = [];
  const waiting: Array<LedgerFollowUpItem> = [];
  for (const item of unfinished) {
    const waitingOn = unreleasedBlockers(item, released);
    const entry = { item, waitingOn };
    if (waitingOn.length > 0 || item.judging === true) waiting.push(entry);
    else actionable.push(entry);
  }
  return { actionable, waiting };
}

export type LedgerDomainEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: `ledger.${string}` }
>;

/**
 * The one reducer for a thread's ledger. The server projection and every client fold events
 * through it so they cannot disagree. An event for a ledger other than the current one is a
 * stale write for a replaced ledger and changes nothing.
 */
export function applyLedgerEvent(
  ledger: Ledger | undefined,
  event: LedgerDomainEvent,
): Ledger | undefined {
  if (event.type === "ledger.created") return event.payload;
  if (ledger === undefined || ledger.id !== event.payload.ledgerId) return ledger;
  switch (event.type) {
    case "ledger.item.added": {
      const items = [...ledger.items];
      for (const added of event.payload.items) {
        const index = items.findIndex((item) => item.id === added.id);
        if (index === -1) items.push(added);
        else items[index] = added;
      }
      return { ...ledger, items, updatedAt: event.payload.updatedAt };
    }
    case "ledger.item.updated":
      return {
        ...ledger,
        items: ledger.items.map((item) =>
          item.id === event.payload.item.id ? event.payload.item : item,
        ),
        updatedAt: event.payload.updatedAt,
      };
    case "ledger.checkpoint.updated":
      return {
        ...ledger,
        checkpoints: ledger.checkpoints.map((checkpoint) =>
          checkpoint.id === event.payload.checkpoint.id ? event.payload.checkpoint : checkpoint,
        ),
        updatedAt: event.payload.updatedAt,
      };
    case "ledger.closed":
      return { ...ledger, closedAt: event.payload.closedAt, updatedAt: event.payload.updatedAt };
    case "ledger.reopened":
      return { ...ledger, closedAt: null, updatedAt: event.payload.updatedAt };
    case "ledger.investigation.updated":
      return {
        ...ledger,
        investigation: event.payload.investigation,
        updatedAt: event.payload.updatedAt,
      };
  }
}
