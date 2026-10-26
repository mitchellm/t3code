import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  AGENT_RULE_PIN_TEXT_MAX_LENGTH,
  AGENT_RULE_PINS_MAX_COUNT,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ThreadRulePin,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { OrchestratorDispatchError } from "../../../orchestration-v2/Orchestrator.ts";
import { planRulePinChange } from "../../../orchestration-v2/threadRulePins.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";

const ownThread = ThreadId.make("thread:pins-own");
const NOW = "2026-10-26T00:00:00.000Z";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:pins"),
  requestNamespace: "pins-session",
  thread: {
    threadId: ownThread,
    providerSessionId: "pins-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "pins-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pins-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** Runs the real pin planner behind the thread management seam, as the orchestrator does. */
const makeFakeThreads = (initial: ReadonlyArray<ThreadRulePin> = []) => {
  const state = { pins: initial };
  const layer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
    getProjectThreadRecords: ({ threadId }) => {
      const projection = idleThreadProjection(liveThreadShell(threadId));
      return Effect.succeed({
        ...projection,
        thread: { ...projection.thread, rulePins: state.pins },
      });
    },
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type !== "thread.rule-pin.add" && command.type !== "thread.rule-pin.remove") {
          return yield* Effect.die("only pin commands expected");
        }
        const plan = planRulePinChange({ pins: state.pins, now: NOW, command });
        if (plan._tag === "rejected") {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: plan.reason,
          });
        }
        if (plan._tag === "changed") state.pins = plan.pins;
        return { sequence: 1, storedEvents: [] };
      }),
  });
  return { layer, state };
};

const withServer = <A, E>(
  fake: { readonly layer: Layer.Layer<ThreadManagement.ThreadManagementService> },
  body: (
    call: (name: string, args: Record<string, unknown>) => Effect.Effect<McpSchema.CallToolResult>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* body((name, args) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.orDie,
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        ),
    );
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAgentPinsToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(fake.layer),
      ),
    ),
  );

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const userPin: ThreadRulePin = {
  id: "u1",
  text: "Never touch generated/ files.",
  author: "user",
  sourceMessageId: null,
  createdAt: NOW,
};

it.effect("pin_add stores an agent-authored pin on the caller's own thread", () => {
  const fake = makeFakeThreads([userPin]);
  return withServer(fake, (call) =>
    Effect.gen(function* () {
      const added = yield* call("pin_add", { text: "Dev server runs on port 4000" });
      expect(failureOf(added)).toBeUndefined();
      expect(fake.state.pins.map((pin) => [pin.text, pin.author])).toEqual([
        ["Never touch generated/ files.", "user"],
        ["Dev server runs on port 4000", "agent"],
      ]);
      // The reply lists only the agent's pins, never the user's rules.
      expect(added.structuredContent).toMatchObject({
        pins: [{ text: "Dev server runs on port 4000" }],
      });
    }),
  );
});

it.effect("pin_add refuses over-length text and an eleventh pin with a clear message", () => {
  const fake = makeFakeThreads();
  return withServer(fake, (call) =>
    Effect.gen(function* () {
      const long = yield* call("pin_add", { text: "x".repeat(AGENT_RULE_PIN_TEXT_MAX_LENGTH + 1) });
      expect(failureOf(long)?.message).toContain(String(AGENT_RULE_PIN_TEXT_MAX_LENGTH));
      for (let i = 0; i < AGENT_RULE_PINS_MAX_COUNT; i += 1) {
        expect(failureOf(yield* call("pin_add", { text: `note ${i}` }))).toBeUndefined();
      }
      const over = yield* call("pin_add", { text: "one too many" });
      expect(failureOf(over)?.message).toContain(String(AGENT_RULE_PINS_MAX_COUNT));
      expect(fake.state.pins).toHaveLength(AGENT_RULE_PINS_MAX_COUNT);
    }),
  );
});

it.effect("an identical retry of pin_add does not add a second pin", () => {
  const fake = makeFakeThreads();
  return withServer(fake, (call) =>
    Effect.gen(function* () {
      yield* call("pin_add", { text: "same note" });
      yield* call("pin_add", { text: "same note" });
      expect(fake.state.pins).toHaveLength(1);
    }),
  );
});

it.effect("pin_remove removes the agent's own pin but never a user's", () => {
  const fake = makeFakeThreads([userPin]);
  return withServer(fake, (call) =>
    Effect.gen(function* () {
      yield* call("pin_add", { text: "temporary note" });
      const agentPin = fake.state.pins.find((pin) => pin.author === "agent")!;
      const refused = yield* call("pin_remove", { pinId: userPin.id });
      expect(failureOf(refused)?.message).toContain("only the user can remove");
      expect(fake.state.pins.some((pin) => pin.id === userPin.id)).toBe(true);
      expect(failureOf(yield* call("pin_remove", { pinId: agentPin.id }))).toBeUndefined();
      expect(fake.state.pins.map((pin) => pin.id)).toEqual([userPin.id]);
    }),
  );
});
