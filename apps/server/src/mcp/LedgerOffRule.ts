/**
 * Fork: whether a thread runs without the task ledger (the `taskLedger` project setting; the rule
 * itself is `taskLedgerOff`) and nobody asked it for one. The ledger tools refuse while this holds,
 * and the tool list leaves them out, so the two cannot disagree.
 */
import type { OrchestratorMcpFailure, ProjectId, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { isLedgerRequest, wasAsked } from "@t3tools/shared/taskLedger";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  type LedgerLink,
  ledgerLinkOf,
  readLedgerChain,
  taskLedgerOff,
} from "../orchestration-v2/TaskLedgerSwitch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { unavailable } from "./threadAccess.ts";

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  /** Whether the user's latest message is the one a `/ledger` command sends. */
  const latestAskIsLedgerRequest = Effect.fn("LedgerOffRule.latestAskIsLedgerRequest")(function* (
    threadId: ThreadId,
  ) {
    const { messages } = yield* threads
      .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.mapError(unavailable));
    const latest = messages
      .filter(wasAsked)
      .reduce<(typeof messages)[number] | undefined>(
        (last, message) =>
          last === undefined ||
          DateTime.toEpochMillis(message.createdAt) >= DateTime.toEpochMillis(last.createdAt)
            ? message
            : last,
        undefined,
      );
    return latest !== undefined && isLedgerRequest(latest.text);
  });

  /**
   * For a thread known to have no ledger of its own. A ledger the user asked for with `/ledger`
   * is never withheld, which is also why a tool list taken after that message offers the tools.
   */
  const withholdsLedger = Effect.fn("LedgerOffRule.withholdsLedger")(function* (own: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly link: LedgerLink;
  }): Effect.fn.Return<boolean, OrchestratorMcpFailure> {
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(unavailable));
    const resolved = resolveProjectSettings(settings, own.projectId).settings;
    if (resolved.taskLedger === true) return false;
    const chain = yield* readLedgerChain(own.threadId, (id) =>
      id === own.threadId
        ? Effect.succeed(own.link)
        : threads
            .getProjectThreadRecords({ projectId: own.projectId, threadId: id }, ["ledger"])
            .pipe(Effect.map(ledgerLinkOf), Effect.mapError(unavailable)),
    );
    return taskLedgerOff(resolved, chain) && !(yield* latestAskIsLedgerRequest(own.threadId));
  });

  /** As `withholdsLedger`, for a caller that has only the thread's id, as the tool list does. */
  const withholdsLedgerFromThread = Effect.fn("LedgerOffRule.withholdsLedgerFromThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<boolean, OrchestratorMcpFailure> {
    // An install that turned the ledger on and no project off skips the thread reads; the tool
    // list asks once per ledger tool.
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(unavailable));
    const offAnywhere =
      settings.taskLedger !== true ||
      Object.values(settings.projectSettingsOverrides ?? {}).some(
        (override) => override.taskLedger === false,
      );
    if (!offAnywhere) return false;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) return false;
    const records = yield* threads
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, ["ledger"])
      .pipe(Effect.mapError(unavailable));
    if (records.ledger !== undefined) return false;
    return yield* withholdsLedger({
      threadId,
      projectId: shell.projectId,
      link: ledgerLinkOf(records),
    });
  });

  return { withholdsLedger, withholdsLedgerFromThread };
});
