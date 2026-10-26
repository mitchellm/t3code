/**
 * Fork: "stall means replan, not stop" (after Magentic-One's progress ledger). Before giving up
 * on a ledger that stopped moving, or an item the judge keeps failing, the agent gets one nudge to
 * change the plan rather than retry it. Pure: the between-turn follow-up (LedgerAutoContinue) and
 * Claude's in-run Stop hook (HarnessHooks) both decide here, and neither keeps extra state for it.
 */
import type { Ledger, LedgerItem } from "@t3tools/contracts";
import {
  decideLedgerAutoContinue,
  type LedgerAutoContinueDecision,
  type LedgerProgressMark,
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
 * The projection keeps how many verdicts an item got and the latest one, not every outcome. A pass
 * normally closes the item, so on an item still open whose latest verdict failed, the count is its
 * failures; a pass that left it open (a blocker reopened mid-judgement) is the rare overcount.
 */
export const judgeFailures = (item: Pick<LedgerItem, "verdict" | "judgements">): number =>
  item.verdict?.outcome === "fail" ? (item.judgements ?? 0) : 0;

/** Open items handed back by the judge often enough to need a new plan, not yet replanned. */
function judgeReplanDue(
  open: ReadonlyArray<LedgerItem>,
  alreadyReplanned: ReadonlySet<string>,
): ReadonlyArray<LedgerItem> {
  return open.filter(
    (item) =>
      item.judging !== true &&
      !alreadyReplanned.has(item.id) &&
      judgeFailures(item) >= LEDGER_JUDGE_FAILURE_REPLAN_THRESHOLD,
  );
}

const itemLines = (reason: LedgerReplanReason, items: ReadonlyArray<LedgerItem>) => {
  const lines = items.slice(0, ITEMS_SHOWN).map((item) => {
    const head = `- ${item.id} [${item.status}] ${item.title}\n  Acceptance: ${clip(item.acceptance, ACCEPTANCE_MAX_CHARS)}`;
    if (reason !== "judge" || item.verdict === null) return head;
    return `${head}\n  Failed the judge ${judgeFailures(item)} times; last notes: ${clip(item.verdict.notes, NOTES_MAX_CHARS)}`;
  });
  const hidden = items.length - ITEMS_SHOWN;
  return hidden > 0 ? [...lines, `- and ${hidden} more`] : lines;
};

/** The replan instruction, for a follow-up message and for a Stop hook block reason alike. */
export function ledgerReplanText(input: {
  readonly ledger: Pick<Ledger, "title">;
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
    ...itemLines(reason, items),
    reason === "stalled"
      ? "If the ledger is still unchanged after this, automatic follow-ups stop and the user is asked to look."
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export type LedgerFollowUpDecision =
  | LedgerAutoContinueDecision
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
function replanHistory(messages: LedgerFollowUpInput["messages"]) {
  let streak = 0;
  let latestWasReplan: boolean | undefined;
  const judgeReplanned = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const source = message.notification?.source;
    if (source?.kind === "ledger_continue") {
      streak += 1;
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
  if (ledger === undefined || base.type === "idle") return base;
  if (base.type === "stuck" && base.reason === "cap") return base;
  const history = replanHistory(input.messages);
  if (base.type === "stuck") {
    if (history.latestWasReplan) return base;
    const open = ledger.items.filter(isOpen);
    return {
      type: "replan",
      reason: "stalled",
      round: history.streak + 1,
      open,
      items: ledger.items.map(progressMark),
      replanItems: open,
      replanItemIds: open.map((item) => item.id),
    };
  }
  const due = judgeReplanDue(base.open, history.judgeReplanned);
  if (due.length === 0) return base;
  return {
    ...base,
    type: "replan",
    reason: "judge",
    replanItems: due,
    replanItemIds: due.map((item) => item.id),
  };
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
  readonly open: ReadonlyArray<LedgerItem>;
  readonly unchangedBlocks: number;
  readonly limit: number;
  readonly judgeReplanned: ReadonlySet<string>;
}): StopHookNudge {
  if (input.unchangedBlocks > input.limit) return { type: "allow" };
  if (input.unchangedBlocks === input.limit) {
    return { type: "replan", reason: "stalled", items: input.open };
  }
  const due = judgeReplanDue(input.open, input.judgeReplanned);
  return due.length === 0 ? { type: "block" } : { type: "replan", reason: "judge", items: due };
}
