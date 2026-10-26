import type { AgentPinMcpAddInput, AgentPinMcpRemoveInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentPinsMcpService from "../../AgentPinsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AgentPinsToolkit } from "./tools.ts";

const handlers = {
  pin_add: McpToolAccess.actsAsCaller((input: AgentPinMcpAddInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentPinsMcpService.AgentPinsMcpService;
      return yield* service.add(scope, input);
    }),
  ),
  pin_remove: McpToolAccess.actsAsCaller((input: AgentPinMcpRemoveInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* AgentPinsMcpService.AgentPinsMcpService;
      return yield* service.remove(scope, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof AgentPinsToolkit.tools>;

export const layer = McpToolAccess.toLayer(AgentPinsToolkit, handlers);
