import type {
  Ledger,
  LedgerItem,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";

/** Consecutive server follow-ups per thread before it stops and waits for the user. */
export const LEDGER_AUTO_CONTINUE_CAP = 5;

export type LedgerAutoContinueDecision =
  | { readonly type: "idle" }
  | {
      readonly type: "continue";
      readonly round: number;
      readonly open: ReadonlyArray<LedgerItem>;
      readonly items: ReadonlyArray<Pick<LedgerItem, "id" | "status">>;
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

const signatureOf = (items: ReadonlyArray<Pick<LedgerItem, "id" | "status">>) =>
  items
    .map((item) => `${item.id}:${item.status}`)
    .sort()
    .join("\n");

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
  let previous: ReadonlyArray<Pick<LedgerItem, "id" | "status">> | undefined;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (message.role !== "user") continue;
    if (message.notification?.source.kind === "ledger_continue") {
      if (message.runId != null && input.cancelledRunIds?.has(message.runId) === true) {
        return { type: "idle" };
      }
      streak += 1;
      previous ??= message.notification.source.items;
    } else if (message.createdBy === "user" && message.creationSource !== "server") {
      break;
    }
  }

  const items = ledger.items.map(({ id, status }) => ({ id, status }));
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
  }
}
