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
// Some stops never meet a report that consumes them: a stop that fails, a stop seen in a
// continuation turn (which records no reports), a stop replayed by a drain. Keeping only the
// newest bounds the set for a long session.
const REMEMBERED_STOPS = 64;

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
  // Insertion-ordered, so the first entry is the oldest stop.
  const requested = new Set<string>();
  return {
    observe(message: SDKMessage): void {
      for (const taskId of stoppedTaskIds(message)) {
        requested.delete(taskId);
        requested.add(taskId);
      }
      for (const oldest of requested) {
        if (requested.size <= REMEMBERED_STOPS) break;
        requested.delete(oldest);
      }
    },
    /**
     * True for the stop report of a shell or monitor the agent stopped itself. Any report for a
     * stopped task ends that stop, whatever its kind or outcome.
     */
    wakesNoTurn(taskId: string, report: BackgroundWorkReport): boolean {
      return (
        requested.delete(taskId) && report.kind !== "subagent" && report.outcome === "cancelled"
      );
    },
  };
}
