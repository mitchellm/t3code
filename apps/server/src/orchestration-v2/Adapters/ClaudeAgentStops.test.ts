import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundWorkReport } from "@t3tools/provider-core/server/notification";
import { describe, expect, it } from "vite-plus/test";

import { makeClaudeAgentStops } from "./ClaudeAgentStops.ts";

function sdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

const stopFrame = (name: string, input: Record<string, string>) =>
  sdkFrame({
    type: "assistant",
    message: {
      id: `msg_${name}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: `toolu_${name}`, name, input }],
    },
    parent_tool_use_id: null,
  });

const stoppedShell: BackgroundWorkReport = { kind: "command", outcome: "cancelled" };

describe("makeClaudeAgentStops", () => {
  it("ends a stop with the first report for its task, whatever that report says", () => {
    const stops = makeClaudeAgentStops();
    stops.observe(stopFrame("TaskStop", { task_id: "agent-1" }));
    stops.observe(stopFrame("TaskStop", { task_id: "shell-raced" }));
    stops.observe(stopFrame("KillShell", { shell_id: "shell-killed" }));

    // A stopped subagent does wake the agent, and a stop that lost the race reports completion.
    expect(stops.wakesNoTurn("agent-1", { kind: "subagent", outcome: "cancelled" })).toBe(false);
    expect(stops.wakesNoTurn("shell-raced", { kind: "command", outcome: "completed" })).toBe(false);
    expect(stops.wakesNoTurn("shell-killed", stoppedShell)).toBe(true);

    for (const taskId of ["agent-1", "shell-raced", "shell-killed"]) {
      expect(stops.wakesNoTurn(taskId, stoppedShell)).toBe(false);
    }
  });

  it("forgets the oldest stops that no report ever ends", () => {
    const stops = makeClaudeAgentStops();
    const taskIds = Array.from({ length: 200 }, (_, index) => `shell-${index}`);
    for (const taskId of taskIds) {
      stops.observe(stopFrame("TaskStop", { task_id: taskId }));
    }

    expect(stops.wakesNoTurn("shell-0", stoppedShell)).toBe(false);
    expect(stops.wakesNoTurn("shell-199", stoppedShell)).toBe(true);
  });
});
