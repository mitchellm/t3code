import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  findInvestigationLock,
  type InvestigationCallerLock,
  spawnRefusalFor,
} from "../orchestration-v2/Investigation.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { unavailable } from "./threadAccess.ts";

/**
 * Fork: Investigate mode's one spawn rule, applied to every agent tool that can start or wake
 * work or replace the ledger (see `investigationSpawnGuard`). This module reads what the pure
 * guard needs; the handlers call `guardInvestigationSpawn` before doing anything.
 */

type Threads = ThreadManagement.ThreadManagementService["Service"];

/**
 * When the user last wrote on the thread after `since`. Only runs still live at `since` or later
 * can hold a newer message, so just those runs' user messages are read. The server's report and
 * wake turns are authored by the agent from the server, so they never count.
 */
export const latestUserMessageAt = Effect.fn("InvestigationSpawnGuard.latestUserMessageAt")(
  function* (threads: Threads, threadId: ThreadId, since: DateTime.Utc) {
    const sinceMs = DateTime.toEpochMillis(since);
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    const runIds = runs
      .filter(
        (run) => run.completedAt === null || DateTime.toEpochMillis(run.completedAt) >= sinceMs,
      )
      .map(({ id }) => id);
    if (runIds.length === 0) return null;
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
      messageRunIds: runIds,
    });
    let latest: DateTime.Utc | null = null;
    for (const message of messages) {
      if (message.createdBy !== "user" || message.creationSource === "server") continue;
      if (
        latest === null ||
        DateTime.toEpochMillis(message.createdAt) > DateTime.toEpochMillis(latest)
      ) {
        latest = message.createdAt;
      }
    }
    return latest;
  },
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
