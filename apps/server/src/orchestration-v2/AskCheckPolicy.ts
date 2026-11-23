/**
 * Fork: the texts of the v2 ask check policy ("Two tries, then hand over, then stop"). Pure, so the
 * planner, the judge's wake and the stop notice all say the same thing.
 */

/** Failed checks, counted for the ledger, at which the thread is handed to the stronger checker. */
export const ASK_CHECK_HAND_OVER_AFTER_FAILS = 2;

/** Failed checks, counted for the ledger, at which the ledger stops. */
export const ASK_CHECK_STOP_AFTER_FAILS = 3;

/** What an agent's close, or an explicit check request, is refused with once the ledger stopped. */
export const ASK_CHECK_STOPPED_TEXT =
  "The check failed three times and has stopped. Tell the user what is done, what the last check found (ledger_read has its notes) and what you would try next; do not keep changing code for this item unless they ask.";

/** The head of the wake after the second failed check, when the stronger checker took the thread. */
export const askCheckHandOverText = (model: string): string =>
  `The check failed twice, so ${model} has taken over this thread from here. The work so far is in the checkout; what the check found is below.`;

/** The user's notice when their next message puts a handed-over thread back on its own model. */
export const askCheckBackOnOwnModelNoticeText = (own: string, handedTo: string): string =>
  `This thread is back on ${own}; ${handedTo} took over only for the last request.`;

/** The user's notice when the stop leaves the agent's turn over with items still open. */
export const askCheckStopNoticeText = (openItems: number): string =>
  `The check failed three times; the agent stopped with ${openItems} ${openItems === 1 ? "item" : "items"} open.`;

/**
 * The wake the agent gets for a failed check the server handles itself: the second or later fail of
 * a v2 ledger. `notes` is what the check found; the head says what changed for the agent.
 */
export function askCheckFailureWake(input: {
  /** Failed checks on the ledger, this one included. */
  readonly fails: number;
  /** The model the thread was just handed to, when it was. */
  readonly handedOverTo: string | undefined;
  readonly notes: string;
}): string {
  const head =
    input.fails >= ASK_CHECK_STOP_AFTER_FAILS
      ? ASK_CHECK_STOPPED_TEXT
      : input.handedOverTo === undefined
        ? undefined
        : askCheckHandOverText(input.handedOverTo);
  return head === undefined ? input.notes : `${head}\n\n${input.notes}`;
}
