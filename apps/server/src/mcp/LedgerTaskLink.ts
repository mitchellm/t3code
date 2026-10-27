import {
  type CommandId,
  type LedgerId,
  type LedgerItemId,
  type LedgerItemTaskDraft,
  OrchestratorMcpFailure,
  type OrchestrationV2Subagent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import { ledgerTaskLinkProblem } from "../orchestration-v2/TaskLedger.ts";
import type {
  ThreadManagementProviderInstanceDisabledError,
  ThreadManagementServiceShape,
} from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Fork: delegate_task's `ledgerItemId`. The ledger is the calling thread's own, the one the ledger
 * tools act on, so an agent can only link work to its own plan.
 */
export interface LedgerLinkTarget {
  readonly threadId: ThreadId;
  readonly ledgerId: LedgerId;
  readonly ledgerCreatedAt: DateTime.Utc;
  readonly itemId: LedgerItemId;
}

/**
 * Checks the item can take work before any work starts. A retry of an accepted delegation is not
 * checked again: its task already runs, and the link it may still owe is idempotent.
 */
export const resolveLedgerLink = Effect.fn("LedgerTaskLink.resolve")(function* (
  threads: Pick<ThreadManagementServiceShape, "getProjectThreadRecords">,
  input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly itemId: LedgerItemId | undefined;
    readonly isRetry: boolean;
  },
): Effect.fn.Return<LedgerLinkTarget | undefined, OrchestratorMcpFailure> {
  if (input.itemId === undefined) return undefined;
  const { ledger } = yield* threads
    .getProjectThreadRecords({ projectId: input.projectId, threadId: input.threadId }, ["ledger"])
    .pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Unable to read this thread's ledger to check ledgerItemId.",
          }),
      ),
    );
  const problem = input.isRetry ? undefined : ledgerTaskLinkProblem(ledger, input.itemId);
  if (problem !== undefined) {
    return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: problem });
  }
  return ledger === undefined
    ? undefined
    : {
        threadId: input.threadId,
        ledgerId: ledger.id,
        ledgerCreatedAt: ledger.createdAt,
        itemId: input.itemId,
      };
});

/** The link as the task was started; an app-owned task always has a child thread and a model. */
const linkedTaskOf = (task: OrchestrationV2Subagent): LedgerItemTaskDraft | undefined =>
  task.childThreadId === null || task.model === null || task.model.trim() === ""
    ? undefined
    : {
        taskId: task.id,
        childThreadId: task.childThreadId,
        ...(task.role === undefined ? {} : { role: task.role }),
        providerInstanceId: task.providerInstanceId,
        model: task.model,
      };

/** The planner's own words when it refused; a retry replays them from the stored rejection. */
const rejectionReason = (
  error: OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError,
): string =>
  error._tag === "OrchestratorDispatchError" && typeof error.cause === "string"
    ? error.cause
    : error._tag === "OrchestratorCommandPreviouslyRejectedError"
      ? error.detail
      : "the ledger could not be updated.";

/**
 * Writes the link through the ledger's own command, so it is persisted and projected like any
 * item change. The task already runs, so a link that cannot be written does not fail the call;
 * the note it returns goes in the result, so the agent knows the item does not list the task.
 */
export const linkDelegatedTask = Effect.fn("LedgerTaskLink.link")(function* (
  threads: Pick<ThreadManagementServiceShape, "dispatch">,
  input: {
    readonly target: LedgerLinkTarget | undefined;
    readonly task: OrchestrationV2Subagent;
    readonly commandId: CommandId;
  },
): Effect.fn.Return<{ readonly ledgerLink?: string }> {
  const { target, task } = input;
  if (target === undefined) return {};
  // A thread holds one ledger at a time, so one created after the task started replaced the
  // ledger delegate_task checked; a retry must not attach the task to its same-named item.
  if (
    task.startedAt !== null &&
    DateTime.toEpochMillis(target.ledgerCreatedAt) > DateTime.toEpochMillis(task.startedAt)
  ) {
    return {
      ledgerLink:
        "rejected: this thread's ledger was replaced after the task started, so the task belongs to no item of it.",
    };
  }
  const linked = linkedTaskOf(task);
  if (linked === undefined) {
    return { ledgerLink: "rejected: the task has no child thread or model to record." };
  }
  return yield* threads
    .dispatch({
      type: "ledger.item.task.link",
      commandId: input.commandId,
      threadId: target.threadId,
      ledgerId: target.ledgerId,
      itemId: target.itemId,
      task: linked,
    })
    .pipe(
      Effect.as({}),
      Effect.catch((error) =>
        Effect.succeed({
          ledgerLink: `rejected: ${Array.from(rejectionReason(error)).slice(0, 500).join("")}`,
        }),
      ),
    );
});
