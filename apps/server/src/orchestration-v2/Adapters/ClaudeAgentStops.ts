/**
 * Fork: the CLI wakes the agent when a subagent it stopped ends, but queues no wake for a shell or
 * monitor it stopped with TaskStop. A report kept for such a stop would label the next, unrelated
 * wake as stopped work, so it is never recorded.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundWorkReport } from "@t3tools/provider-core/server/notification";

// KillShell is TaskStop's older name, and TaskStop still accepts KillShell's shell_id.
const STOP_TOOLS: ReadonlySet<string> = new Set(["TaskStop", "KillShell"]);
const STOP_ID_KEYS = ["task_id", "shell_id"] as const;

function stoppedTaskIds(message: SDKMessage): ReadonlyArray<string> {
  if (message.type !== "assistant") return [];
  return message.message.content.flatMap((block) => {
    if (block.type !== "tool_use" || !STOP_TOOLS.has(block.name)) return [];
    const input: unknown = block.input;
    if (typeof input !== "object" || input === null) return [];
    return STOP_ID_KEYS.flatMap((key) => {
      const id: unknown = Reflect.get(input, key);
      return typeof id === "string" && id.length > 0 ? [id] : [];
    });
  });
}

export function makeClaudeAgentStops() {
  const requested = new Set<string>();
  return {
    observe(message: SDKMessage): void {
      for (const taskId of stoppedTaskIds(message)) requested.add(taskId);
    },
    /** True for the stop report of a shell or monitor the agent stopped itself; consumes the stop. */
    wakesNoTurn(taskId: string, report: BackgroundWorkReport): boolean {
      if (report.kind === "subagent" || report.outcome !== "cancelled") return false;
      return requested.delete(taskId);
    },
  };
}
