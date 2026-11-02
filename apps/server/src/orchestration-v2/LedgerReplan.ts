/**
 * Fork: "stall means replan, not stop" (after Magentic-One's progress ledger). Before giving up
 * on a ledger that stopped moving, or an item the judge keeps failing, the agent gets one nudge to
 * change the plan rather than retry it. Pure: the between-turn follow-up (LedgerAutoContinue) and
 * Claude's in-run Stop hook (HarnessHooks) both decide here, and neither keeps extra state for it.
 */
import type { Ledger, LedgerItem } from "@t3tools/contracts";
import {
  decideLedgerAutoContinue,
  finishedSince,
  isLedgerFollowUpRound,
  type LedgerAutoContinueDecision,
  type LedgerProgressMark,
  partitionLedgerFollowUp,
  progressMark,
} from "@t3tools/shared/taskLedger";

/** Failed verdicts on one item before the next nudge asks to replan it instead of retrying. */
export const LEDGER_JUDGE_FAILURE_REPLAN_THRESHOLD = 3;

export type LedgerReplanReason = "stalled" | "judge";

const ACCEPTANCE_MAX_CHARS = 600;
const NOTES_MAX_CHARS = 400;
const ITEMS_SHOWN = 10;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const isOpen = (item: Pick<LedgerItem, "status">) =>
  item.status === "open" || item.status === "in_progress";

/**
 * The projection keeps how many verdicts an item got, not each outcome, so failures are the
 * verdicts since the planner's baseline (last reopen or last pass), while the latest one failed.
 */
export const judgeFailures = (
  item: Pick<LedgerItem, "verdict" | "judgements" | "judgementsAtReopen">,
): number =>
  item.verdict?.outcome === "fail" ? (item.judgements ?? 0) - (item.judgementsAtReopen ?? 0) : 0;

const isJudgeReplanDue = (item: LedgerItem) =>
  item.judging !== true && judgeFailures(item) >= LEDGER_JUDGE_FAILURE_REPLAN_THRESHOLD;

/**
 * A stall replan names only what the agent can act on now; an item waiting on a blocker or on the
 * judge is replanned through the item that holds it up. With nothing actionable, every open item.
 */
function stalledItems(ledger: Ledger, open: ReadonlyArray<LedgerItem>): ReadonlyArray<LedgerItem> {
  const { actionable } = partitionLedgerFollowUp(ledger, open);
  return actionable.length === 0 ? open : actionable.map(({ item }) => item);
}

/** Open items handed back by the judge often enough to need a new plan, not yet replanned. */
function judgeReplanDue(
  open: ReadonlyArray<LedgerItem>,
  alreadyReplanned: ReadonlySet<string>,
): ReadonlyArray<LedgerItem> {
  return open.filter((item) => !alreadyReplanned.has(item.id) && isJudgeReplanDue(item));
}

const itemLines = (items: ReadonlyArray<LedgerItem>) => {
  const lines = items.slice(0, ITEMS_SHOWN).map((item) => {
    const head = `- ${item.id} [${item.status}] ${item.title}\n  Acceptance: ${clip(item.acceptance, ACCEPTANCE_MAX_CHARS)}`;
    // A stall replan keeps the judge's notes too: they say why the item is stuck.
    if (item.verdict === null || !isJudgeReplanDue(item)) return head;
    return `${head}\n  Failed the judge ${judgeFailures(item)} times; last notes: ${clip(item.verdict.notes, NOTES_MAX_CHARS)}`;
  });
  const hidden = items.length - ITEMS_SHOWN;
  return hidden > 0 ? [...lines, `- and ${hidden} more`] : lines;
};

/**
 * On a judged ledger the planner sends an agent's drop or defer of work it started to the judge,
 * so every nudge that offers those says so: an agent that believes it cannot set work aside
 * resubmits evidence that will fail, or stalls waiting on the user.
 */
export const JUDGED_SET_ASIDE_HINT =
  "On this judged ledger, dropping or deferring an item you already started goes to the judge like a close: give a dropReason or deferReason that says why it no longer needs doing (for example which item replaced it and passed, or what makes its acceptance impossible), and it is set aside when the judge agrees. Do not resubmit evidence the judge already failed for the same reason.";

/** The replan instruction, for a follow-up message and for a Stop hook block reason alike. */
export function ledgerReplanText(input: {
  readonly ledger: Pick<Ledger, "title" | "requiresJudge">;
  readonly reason: LedgerReplanReason;
  readonly items: ReadonlyArray<LedgerItem>;
  /** The between-turn follow-up round; absent inside a run. */
  readonly round?: number;
}): string {
  const { ledger, reason, items } = input;
  const round = input.round === undefined ? "" : ` (automatic follow-up ${input.round})`;
  const why =
    reason === "stalled"
      ? `The task ledger "${ledger.title}" made no progress since the last nudge${round}. Retrying the same plan will not help: replan.`
      : `${items.map((item) => item.id).join(", ")} failed the judge ${LEDGER_JUDGE_FAILURE_REPLAN_THRESHOLD} times or more on the task ledger "${ledger.title}"${round}. Asking again with the same work will not pass: replan ${items.length === 1 ? "it" : "them"}.`;
  return [
    why,
    "Re-read the ledger (ledger_read). For each item below decide one of: split it into smaller sub-items (ledger_add_items with parentItemId); rewrite its acceptance so it can actually be met (drop it with a reason and add a replacement item); mark it blocked by something new (add the blocker as an item and set blockedBy); or defer it with a reason. Record the decision in the ledger, then continue with the new plan.",
    ledger.requiresJudge === true ? JUDGED_SET_ASIDE_HINT : "",
    ...itemLines(items),
    reason === "stalled"
      ? "If the ledger is still unchanged after this, automatic follow-ups stop and the user is asked to look."
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * The text of the one-shot hint for a judged ledger that went idle on items the judge failed. The
 * planner's usual reply to a failed item it cannot finish is to ask the user to drop it, which
 * nothing else corrects once the ledger is idle, because only a nudge carries the set-aside rule.
 */
export function ledgerSetAsideHintText(input: {
  readonly ledger: Pick<Ledger, "title">;
  readonly items: ReadonlyArray<LedgerItem>;
}): string {
  const { ledger, items } = input;
  const lines = items.slice(0, ITEMS_SHOWN).map((item) => {
    const notes =
      item.verdict === null
        ? ""
        : `\n  Last judge notes: ${clip(item.verdict.notes, NOTES_MAX_CHARS)}`;
    return `- ${item.id} [${item.status}] ${item.title}${notes}`;
  });
  const hidden = items.length - ITEMS_SHOWN;
  const them = items.length === 1 ? "it" : "them";
  return [
    `The task ledger "${ledger.title}" is waiting on ${items.map((item) => item.id).join(", ")}, which the judge failed. You can set ${them} aside yourself, so do not ask the user to drop or defer ${them} in the ledger panel.`,
    JUDGED_SET_ASIDE_HINT,
    (hidden > 0 ? [...lines, `- and ${hidden} more`] : lines).join("\n"),
  ].join("\n\n");
}

/** Open items the judge's latest verdict failed and no judge is working on now. */
const judgeFailedItems = (open: ReadonlyArray<LedgerItem>) =>
  open.filter((item) => item.judging !== true && judgeFailures(item) > 0);

/**
 * The hint goes out once per fail: the messages record each item with the verdict count it was
 * sent for, so a restart or a second evaluation of the same idle ledger finds it already sent,
 * and a new failed verdict (a higher count) is a new episode.
 */
function setAsideHintDue(
  messages: LedgerFollowUpInput["messages"],
  failed: ReadonlyArray<LedgerItem>,
): ReadonlyArray<LedgerItem> {
  const sent = new Set<string>();
  for (const message of messages) {
    const source = message.notification?.source;
    if (source?.kind !== "ledger_continue") continue;
    for (const { itemId, judgements } of source.setAsideHint ?? []) {
      sent.add(`${itemId}:${judgements}`);
    }
  }
  return failed.filter((item) => !sent.has(`${item.id}:${item.judgements ?? 0}`));
}

export type LedgerFollowUpDecision =
  | LedgerAutoContinueDecision
  | {
      readonly type: "hint";
      readonly items: ReadonlyArray<LedgerProgressMark>;
      readonly hintItems: ReadonlyArray<LedgerItem>;
    }
  | {
      readonly type: "replan";
      readonly reason: LedgerReplanReason;
      readonly round: number;
      readonly open: ReadonlyArray<LedgerItem>;
      readonly items: ReadonlyArray<LedgerProgressMark>;
      readonly replanItems: ReadonlyArray<LedgerItem>;
      readonly replanItemIds: ReadonlyArray<LedgerItem["id"]>;
    };

type LedgerFollowUpInput = Parameters<typeof decideLedgerAutoContinue>[0];

/**
 * What the replans already sent since the user last spoke say, read from the same follow-up
 * messages the streak counts, so the replan state is the message log itself.
 */
function replanHistory(
  messages: LedgerFollowUpInput["messages"],
  items: ReadonlyArray<LedgerItem>,
) {
  let streak = 0;
  let counting = true;
  let latestWasReplan: boolean | undefined;
  const judgeReplanned = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const source = message.notification?.source;
    if (source?.kind === "ledger_continue" && source.setAsideHint !== undefined) continue;
    if (source?.kind === "ledger_continue") {
      // Same streak as decideLedgerAutoContinue: rounds before the latest finished item drop out.
      counting &&= !finishedSince(source.items, items);
      if (counting) streak += 1;
      latestWasReplan ??= source.replan !== undefined;
      if (source.replan?.reason === "judge") {
        for (const id of source.replan.itemIds) judgeReplanned.add(id);
      }
    } else if (message.createdBy === "user" && message.creationSource !== "server") {
      break;
    }
  }
  return { streak, latestWasReplan: latestWasReplan === true, judgeReplanned };
}

/**
 * The between-turn decision: a stall first earns one replan nudge and stops only if the replan
 * turn changed nothing, and an item at the judge-failure threshold gets one replan nudge naming it.
 * The cap still wins: a replan is a round like any other.
 */
export function decideLedgerFollowUp(input: LedgerFollowUpInput): LedgerFollowUpDecision {
  const base = decideLedgerAutoContinue(input);
  const { ledger } = input;
  if (ledger === undefined) return base;
  if (base.type === "idle") return idleSetAsideHint(input, ledger) ?? base;
  if (base.type === "stuck" && base.reason === "cap") return base;
  const history = replanHistory(input.messages, ledger.items);
  if (base.type === "stuck") {
    // Any replan, the judge's included, is this stall's one replan: a judge replan that moved
    // nothing has used it up, so the stall stops here rather than replanning again.
    if (history.latestWasReplan) return base;
    const open = ledger.items.filter(isOpen);
    const stuck = stalledItems(ledger, open);
    return {
      type: "replan",
      reason: "stalled",
      round: history.streak + 1,
      open,
      items: ledger.items.map(progressMark),
      replanItems: stuck,
      replanItemIds: stuck.map((item) => item.id),
    };
  }
  const due = judgeReplanDue(base.open, history.judgeReplanned);
  if (due.length > 0) {
    return {
      ...base,
      type: "replan",
      reason: "judge",
      replanItems: due,
      replanItemIds: due.map((item) => item.id),
    };
  }
  // A plain round here would only re-find the stall, so the replan (and its hint) goes out now.
  if (!stalledOnTheUser(input.messages, ledger, base.open)) return base;
  const stuck = stalledItems(ledger, base.open);
  return {
    ...base,
    type: "replan",
    reason: "stalled",
    replanItems: stuck,
    replanItemIds: stuck.map((item) => item.id),
  };
}

/**
 * The latest round was a stalled replan, the user has not spoken since, and the only thing that
 * moved is a judge's hand-back: no open item changed status, none finished, none is new. That is
 * a ledger waiting on a decision the agent cannot make alone. A change the agent made itself, or
 * a judge still working, is progress and gets a plain round.
 */
function stalledOnTheUser(
  messages: LedgerFollowUpInput["messages"],
  ledger: Ledger,
  open: ReadonlyArray<LedgerItem>,
): boolean {
  const index = messages.findLastIndex(isLedgerFollowUpRound);
  const source = index < 0 ? undefined : messages[index]!.notification?.source;
  if (source?.kind !== "ledger_continue" || source.replan?.reason !== "stalled") return false;
  const userSpoke = messages
    .slice(index + 1)
    .some((message) => message.createdBy === "user" && message.creationSource !== "server");
  if (userSpoke || open.some((item) => item.judging === true)) return false;
  if (finishedSince(source.items, ledger.items)) return false;
  const statusThen = new Map(source.items.map(({ id, status }) => [id, status]));
  return open.every((item) => statusThen.get(item.id) === item.status);
}

/**
 * A judged ledger that is idle on items the judge failed gets the set-aside rule once. A nudge
 * carries it, but an idle ledger gets no nudge, and an agent that never read it asks the user to
 * drop the item instead. A follow-up the user cancelled stays quiet, as it does for every round.
 */
function idleSetAsideHint(
  input: LedgerFollowUpInput,
  ledger: Ledger,
): LedgerFollowUpDecision | undefined {
  if (ledger.requiresJudge !== true || ledger.closedAt !== null) return undefined;
  const latestRound = input.messages.findLast(isLedgerFollowUpRound);
  if (latestRound?.runId != null && input.cancelledRunIds?.has(latestRound.runId) === true) {
    return undefined;
  }
  const due = setAsideHintDue(input.messages, judgeFailedItems(ledger.items.filter(isOpen)));
  return due.length === 0
    ? undefined
    : { type: "hint", items: ledger.items.map(progressMark), hintItems: due };
}

export type StopHookNudge =
  | { readonly type: "allow" }
  | { readonly type: "block" }
  | {
      readonly type: "replan";
      readonly reason: LedgerReplanReason;
      readonly items: ReadonlyArray<LedgerItem>;
    };

/**
 * The in-run equivalent, from the hook's existing counter of blocks on an unchanged ledger: the
 * block at the limit carries the replan, and only a stop after that is allowed. `judgeReplanned`
 * is what this prompt already replanned for the judge.
 */
export function decideStopHookNudge(input: {
  readonly ledger: Ledger;
  readonly open: ReadonlyArray<LedgerItem>;
  readonly unchangedBlocks: number;
  readonly limit: number;
  readonly judgeReplanned: ReadonlySet<string>;
}): StopHookNudge {
  if (input.unchangedBlocks > input.limit) return { type: "allow" };
  // A judge replan block counts toward the limit, so with no progress it shortens the run of
  // plain blocks before the stall replan rather than adding one.
  if (input.unchangedBlocks === input.limit) {
    return { type: "replan", reason: "stalled", items: stalledItems(input.ledger, input.open) };
  }
  const due = judgeReplanDue(input.open, input.judgeReplanned);
  return due.length === 0 ? { type: "block" } : { type: "replan", reason: "judge", items: due };
}
