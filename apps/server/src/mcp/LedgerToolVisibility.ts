/**
 * Fork: the check that leaves the ledger tools out of `tools/list` for a thread that runs without
 * the task ledger (`LedgerOffRule`). Calls are never filtered: a session opened before the setting
 * changed still lists the tools, and its calls meet their refusal.
 */
import * as Effect from "effect/Effect";

import * as LedgerOffRule from "./LedgerOffRule.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { LedgerToolkit } from "./toolkits/ledger/tools.ts";

// The judgement tool belongs to the orchestrator toolkit, so the toolkit alone does not name it.
const LEDGER_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(LedgerToolkit.tools),
  "ledger_request_judgement",
]);

export const makeCheck = Effect.gen(function* () {
  const rule = yield* LedgerOffRule.make;
  return Effect.fn("LedgerToolVisibility.check")(function* (options: {
    readonly method: string;
    readonly target: string;
  }) {
    if (options.method !== "tools/list" || !LEDGER_TOOLS.has(options.target)) return true;
    const threadId = (yield* McpInvocationContext.McpInvocationContext).thread?.threadId;
    // A client with no calling thread has no ledger to withhold; a failed read keeps the tool listed.
    if (threadId === undefined) return true;
    return !(yield* rule
      .withholdsLedgerFromThread(threadId)
      .pipe(Effect.orElseSucceed(() => false)));
  });
});
