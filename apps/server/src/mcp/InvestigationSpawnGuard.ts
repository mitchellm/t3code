import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  findInvestigationLock,
  type InvestigationCallerLock,
  latestPersonMessageAt,
  spawnRefusalFor,
} from "../orchestration-v2/Investigation.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { unavailable } from "./threadAccess.ts";

/**
 * Fork: Investigate mode's tool guard, the agent's early and clear refusal. The orchestrator's
 * run hold is the backstop that also catches server wakes; both read the same lock.
 */

type Threads = ThreadManagement.ThreadManagementService["Service"];

/** When a person last typed on the thread after `since`, read through thread management. */
export const latestUserMessageAt = (threads: Threads, threadId: ThreadId, since: DateTime.Utc) =>
  latestPersonMessageAt(
    {
      runs: (id) => threads.getThreadRecords(id, ["runs"]).pipe(Effect.map(({ runs }) => runs)),
      userMessages: (id, runIds) =>
        threads
          .getThreadRecords(id, ["messages"], { messageRoles: ["user"], messageRunIds: runIds })
          .pipe(Effect.map(({ messages }) => messages)),
    },
    threadId,
    since,
  );

/** The lock that applies to an agent calling from `threadId`, walking up its subagent chain. */
export const investigationLockFor = Effect.fn("InvestigationSpawnGuard.lockFor")(function* (
  threads: Threads,
  threadId: ThreadId,
): Effect.fn.Return<InvestigationCallerLock, OrchestratorMcpFailure> {
  return yield* findInvestigationLock(
    threadId,
    (id) =>
      threads.getThreadRecords(id, ["ledger", "subagents"]).pipe(Effect.mapError(unavailable)),
    (id, since) => latestUserMessageAt(threads, id, since).pipe(Effect.mapError(unavailable)),
  );
});

/**
 * Refuses `tool` for an agent whose thread is locked. A credential with no calling thread is a
 * client acting for the user, which the rule does not bind.
 */
export const guardInvestigationSpawn = Effect.fn("InvestigationSpawnGuard.guard")(function* (
  tool: string,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) return;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const refusal = spawnRefusalFor(
    yield* investigationLockFor(threads, scope.thread.threadId),
    tool,
  );
  if (refusal !== undefined) {
    return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: refusal });
  }
});
