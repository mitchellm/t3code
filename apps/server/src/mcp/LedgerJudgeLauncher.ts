import type { LedgerItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/**
 * Fork: starts the judge a close request on a judged ledger asks for, without holding the tool
 * call open while it runs. The durable intent is the item's `judging` flag, committed before
 * this runs; the fiber only does the work. A fiber lost to a restart leaves the flag, and the
 * agent's next close request or `ledger_request_judgement` resumes it.
 */
export class LedgerJudgeLauncher extends Context.Service<
  LedgerJudgeLauncher,
  {
    readonly start: (scope: McpInvocationScope, itemId: LedgerItemId) => Effect.Effect<void>;
  }
>()("t3/mcp/LedgerJudgeLauncher") {}

export const layer = Layer.effect(
  LedgerJudgeLauncher,
  Effect.gen(function* () {
    const orchestratorMcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    // One judge per item at a time: a retried close request joins the running one. Fibers end
    // with the server, which is what the durable flag is for.
    const running = yield* FiberMap.make<string>();
    return LedgerJudgeLauncher.of({
      start: (scope, itemId) =>
        FiberMap.run(
          running,
          `${scope.thread?.threadId ?? ""}\u0000${itemId}`,
          orchestratorMcp.judgeInBackground(scope, itemId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("ledger auto-judge failed", {
                threadId: scope.thread?.threadId,
                itemId,
                cause,
              }),
            ),
          ),
          { onlyIfMissing: true },
        ).pipe(Effect.asVoid),
    });
  }),
);
