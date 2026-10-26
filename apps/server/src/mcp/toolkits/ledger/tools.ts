import {
  LedgerMcpAddItemsInput,
  LedgerMcpCreateInput,
  LedgerMcpReadResult,
  LedgerMcpRetryInput,
  LedgerMcpSetCheckpointInput,
  LedgerMcpUpdateItemInput,
  LedgerMcpWriteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as LedgerMcpService from "../../LedgerMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ledgerTool = {
  success: LedgerMcpWriteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    LedgerMcpService.LedgerMcpService,
  ],
};

const retryNote =
  "An identical retry after a lost response is recognised from the arguments and does not repeat the change. Pass clientRequestId only to tell two identical calls apart.";

const LedgerCreateTool = Tool.make("ledger_create", {
  ...ledgerTool,
  description: `Create this thread's task ledger: an itemized checklist that is forced to completion. If it is not in the ledger it does not get done. Use one for multi-step work that takes many turns, or any task with several deliverables. Never use one for a quick question or a one-step change. Keep items small and verifiable, each with an acceptance line saying how it is checked. Item ids and checkpoint ids are short keys you choose ("L1", "C1"), unique within the ledger. Give an item blockedBy when it cannot start until others are closed or dropped, and parentItemId to make it a sub-item. Record out-of-scope work with a deferReason instead of doing it. The thread is auto-continued while any item is open or in_progress, so only list work you intend to finish. A thread has one open ledger; close it before creating another. ${retryNote}`,
  parameters: LedgerMcpCreateInput,
}).annotate(Tool.Destructive, false);

const LedgerAddItemsTool = Tool.make("ledger_add_items", {
  ...ledgerTool,
  description: `Grow the ledger as you discover work: if it is not in the ledger it does not get done. Add every new piece of in-scope work here before doing it, and add out-of-scope work with a deferReason so it is kept for later instead of done now. Same item shape as ledger_create (blockedBy, parentItemId, deferReason); ids must not collide with existing ones. ${retryNote}`,
  parameters: LedgerMcpAddItemsInput,
}).annotate(Tool.Destructive, false);

const LedgerUpdateItemTool = Tool.make("ledger_update_item", {
  ...ledgerTool,
  description: `Move one item through open, in_progress, closed, dropped or deferred, or change its blockedBy or parentItemId. Close an item only with concrete evidence in the same call (test output, a commit, file:line); a claim without proof is rejected. An item cannot start or close while a blocker is unfinished, and a parent cannot close while a sub-item is open. Dropping needs a dropReason; deferring (out of scope, kept for later) needs a deferReason, so defer out-of-scope work instead of doing it. Reopen a closed, dropped or deferred item by setting status to open. When the ledger requires a judge, closing starts the judge automatically: the item shows judging, then closes on a pass or returns to in_progress with the judge's notes on a fail. You cannot set a verdict. The thread is auto-continued while items remain open. ${retryNote}`,
  parameters: LedgerMcpUpdateItemInput,
}).annotate(Tool.Destructive, false);

const LedgerSetCheckpointTool = Tool.make("ledger_set_checkpoint", {
  ...ledgerTool,
  description: `Mark a ledger checkpoint reached (true) or not reached (false). Set it only once the milestone is actually true. ${retryNote}`,
  parameters: LedgerMcpSetCheckpointInput,
}).annotate(Tool.Destructive, false);

const LedgerCloseTool = Tool.make("ledger_close", {
  ...ledgerTool,
  description: `Close this thread's ledger once every item is closed, dropped or deferred; it is rejected while any item is open or in_progress. Deferred items stay on record for later. A closed ledger stops auto-continuing the thread. ${retryNote}`,
  parameters: LedgerMcpRetryInput,
}).annotate(Tool.Destructive, false);

const LedgerReopenTool = Tool.make("ledger_reopen", {
  ...ledgerTool,
  description: `Reopen this thread's closed ledger so it can be edited again. ${retryNote}`,
  parameters: LedgerMcpRetryInput,
}).annotate(Tool.Destructive, false);

const LedgerReadTool = Tool.make("ledger_read", {
  ...ledgerTool,
  description:
    "Read this thread's ledger compactly: status counts, the unfinished (open plus in_progress) count, checkpoints, and every item in tree order (sub-items follow their parent with a greater depth) with its status, blockers (waitingOn lists the unfinished ones), evidence, judging state and verdict notes. Returns ledger null when the thread has none.",
  success: LedgerMcpReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const LedgerToolkit = Toolkit.make(
  LedgerCreateTool,
  LedgerAddItemsTool,
  LedgerUpdateItemTool,
  LedgerSetCheckpointTool,
  LedgerCloseTool,
  LedgerReopenTool,
  LedgerReadTool,
);
