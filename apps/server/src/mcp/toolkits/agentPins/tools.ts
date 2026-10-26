import {
  AgentPinMcpAddInput,
  AgentPinMcpRemoveInput,
  AgentPinMcpResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentPinsMcpService from "../../AgentPinsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const pinTool = {
  success: AgentPinMcpResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AgentPinsMcpService.AgentPinsMcpService,
  ],
};

const PinAddTool = Tool.make("pin_add", {
  ...pinTool,
  description:
    "Pin a short note onto this thread so it survives context compaction: a fact you must not lose, or a verbatim line from the user. Pins are re-sent after compaction under a separate heading that marks them as written by you, not the user, so they never carry the weight of a user rule. Keep each one short, and pin only what you would otherwise lose. This thread only; the user can see and remove your pins.",
  parameters: AgentPinMcpAddInput,
}).annotate(Tool.Destructive, false);

const PinRemoveTool = Tool.make("pin_remove", {
  ...pinTool,
  description:
    "Remove one of your own pins from this thread by id once it is no longer needed. You cannot remove the user's pinned rules.",
  parameters: AgentPinMcpRemoveInput,
}).annotate(Tool.Destructive, false);

export const AgentPinsToolkit = Toolkit.make(PinAddTool, PinRemoveTool);
