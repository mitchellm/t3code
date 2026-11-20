import { describe, expect, it } from "vite-plus/test";

import {
  ASK_CHECK_STOPPED_TEXT,
  askCheckFailureWake,
  askCheckHandOverText,
  askCheckStopNoticeText,
} from "./AskCheckPolicy.ts";

const NOTES =
  "C1: FAIL - the export path in src/export.ts still writes the old names\nVERDICT: FAIL";

describe("the wake after a failed check under the v2 policy", () => {
  it("says the stronger model has taken over after the second failed check, then what the check found", () => {
    expect(askCheckFailureWake({ fails: 2, handedOverTo: "claude-opus-5-5", notes: NOTES })).toBe(
      `The check failed twice, so claude-opus-5-5 has taken over this thread from here. The work so far is in the checkout; what the check found is below.\n\n${NOTES}`,
    );
    expect(askCheckHandOverText("claude-opus-5-5")).toBe(
      "The check failed twice, so claude-opus-5-5 has taken over this thread from here. The work so far is in the checkout; what the check found is below.",
    );
  });

  it("adds nothing to the second wake when nobody took over", () => {
    expect(askCheckFailureWake({ fails: 2, handedOverTo: undefined, notes: NOTES })).toBe(NOTES);
  });

  it("tells the agent the check has stopped after the third, whoever it was handed to", () => {
    const stopped = `The check failed three times and has stopped. Tell the user what is done, what the last check found (ledger_read has its notes) and what you would try next; do not keep changing code for this item unless they ask.\n\n${NOTES}`;
    expect(askCheckFailureWake({ fails: 3, handedOverTo: undefined, notes: NOTES })).toBe(stopped);
    expect(askCheckFailureWake({ fails: 3, handedOverTo: "claude-opus-5-5", notes: NOTES })).toBe(
      stopped,
    );
    expect(ASK_CHECK_STOPPED_TEXT).toBe(
      "The check failed three times and has stopped. Tell the user what is done, what the last check found (ledger_read has its notes) and what you would try next; do not keep changing code for this item unless they ask.",
    );
  });
});

describe("the notice when the agent stops", () => {
  it("counts the items left open, in the singular or the plural", () => {
    expect(askCheckStopNoticeText(1)).toBe(
      "The check failed three times; the agent stopped with 1 item open.",
    );
    expect(askCheckStopNoticeText(3)).toBe(
      "The check failed three times; the agent stopped with 3 items open.",
    );
  });
});
