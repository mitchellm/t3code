import {
  CommandId,
  OrchestratorMcpFailure,
  type AgentPinMcpAddInput,
  type AgentPinMcpRemoveInput,
  type AgentPinMcpResult,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { requireThreadScope, type McpInvocationScope } from "./McpInvocationContext.ts";
import { dispatchFailure, unavailable } from "./threadAccess.ts";

/**
 * Fork: an agent pins notes to its own thread only. No operation takes a thread id, and project
 * rules are not reachable from here. The planner enforces the caps and that an agent can remove
 * only pins it wrote; this service only chooses ids and reports the result.
 */
export class AgentPinsMcpService extends Context.Service<
  AgentPinsMcpService,
  {
    readonly add: (
      scope: McpInvocationScope,
      input: AgentPinMcpAddInput,
    ) => Effect.Effect<AgentPinMcpResult, OrchestratorMcpFailure>;
    readonly remove: (
      scope: McpInvocationScope,
      input: AgentPinMcpRemoveInput,
    ) => Effect.Effect<AgentPinMcpResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/AgentPinsMcpService") {}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const loadOwnPins = Effect.fn("AgentPinsMcpService.loadOwnPins")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot control threads.",
      });
    }
    const { thread } = yield* requireThreadScope(scope, "Pin tools");
    const shell = yield* threads.getThreadShell(thread.threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    const records = yield* threads
      .getProjectThreadRecords({ projectId: shell.projectId, threadId: thread.threadId }, [])
      .pipe(Effect.mapError(unavailable));
    return { threadId: thread.threadId, pins: records.thread.rulePins ?? [] };
  });

  const send = Effect.fn("AgentPinsMcpService.send")(function* (
    scope: McpInvocationScope,
    operation: "add" | "remove",
    build: (ids: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => OrchestrationV2ServerCommand,
  ) {
    const { threadId } = yield* loadOwnPins(scope);
    // Random, so removing a pin and adding the same note again is a new command, not a replayed
    // receipt. A lost reply is made safe by the content-derived pin id instead.
    const commandId = CommandId.make(
      `command:mcp:pin-${operation}:${encodeURIComponent(threadId)}:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    const { sequence } = yield* threads
      .dispatch(build({ commandId, threadId }))
      .pipe(Effect.mapError(dispatchFailure));
    const after = yield* loadOwnPins(scope);
    return {
      sequence,
      pins: after.pins
        .filter((pin) => pin.author === "agent")
        .map((pin) => ({ id: pin.id, text: pin.text })),
    };
  });

  const add = Effect.fn("AgentPinsMcpService.add")(function* (
    scope: McpInvocationScope,
    input: AgentPinMcpAddInput,
  ) {
    // Derived from the text, so a retry after a lost reply names the same pin and is a no-op.
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(input.text.trim()))
      .pipe(Effect.orDie);
    const pinId = `agent-pin-${hex(digest.slice(0, 12))}`;
    return yield* send(scope, "add", ({ commandId, threadId }) => ({
      type: "thread.rule-pin.add",
      commandId,
      threadId,
      pinId,
      text: input.text,
      author: "agent",
    }));
  });

  const remove = Effect.fn("AgentPinsMcpService.remove")(function* (
    scope: McpInvocationScope,
    input: AgentPinMcpRemoveInput,
  ) {
    return yield* send(scope, "remove", ({ commandId, threadId }) => ({
      type: "thread.rule-pin.remove",
      commandId,
      threadId,
      pinId: input.pinId,
      author: "agent",
    }));
  });

  return AgentPinsMcpService.of({ add, remove });
});

export const layer: Layer.Layer<
  AgentPinsMcpService,
  never,
  Crypto.Crypto | ThreadManagementService.ThreadManagementService
> = Layer.effect(AgentPinsMcpService, make);
