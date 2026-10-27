import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";

import { deriveTaskStats, type TaskStatsLiveTool } from "./TaskStats.ts";

const threadId = ThreadId.make("thread:worker");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
  options: [{ id: "effort", value: "xhigh" }],
};
const thread = {
  id: threadId,
  branch: "agent/m4-zones",
  worktreePath: "C:/work/m4",
  modelSelection,
};

const turn = (
  usage: Pick<OrchestrationV2ProviderTurn, "tokenUsage" | "turnTokenUsage">,
): Pick<OrchestrationV2ProviderTurn, "tokenUsage" | "turnTokenUsage"> => usage;

const background = (
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): { readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> } => ({
  pendingBackgroundTasks: tasks,
});

const stats = (
  input: Partial<Parameters<typeof deriveTaskStats>[0]> & { liveTool?: TaskStatsLiveTool | null },
) =>
  deriveTaskStats({
    thread,
    providerTurns: [],
    providerThreads: [],
    toolCalls: 0,
    liveTool: null,
    ...input,
  });

describe("deriveTaskStats", () => {
  it("totals each turn's tokens, falling back to the context snapshot a turn reported", () => {
    const result = stats({
      providerTurns: [
        turn({
          turnTokenUsage: {
            usageScope: "main_agent",
            hasSubagents: false,
            usageStatus: "complete",
            inputTokens: 100_000,
            outputTokens: 12_000,
          },
        }),
        turn({
          tokenUsage: {
            usedTokens: 70_000,
            inputTokens: 60_000,
            outputTokens: 10_000,
            updatedAt: "",
          },
        }),
        // Nothing reported for this turn, so it adds nothing.
        turn({}),
      ],
    });
    assert.deepStrictEqual(result.tokens, { input: 160_000, output: 22_000 });
  });

  it("has no token total when no turn reported usage", () => {
    assert.strictEqual(stats({ providerTurns: [turn({})] }).tokens, null);
  });

  it("names a running tool by its tool name and what it is running", () => {
    // Claude's PowerShell and Bash tools arrive as dynamic tools with no title.
    const powershell = stats({
      liveTool: {
        type: "dynamic_tool",
        title: null,
        toolName: "PowerShell",
        detail: "Start-Sleep -Seconds 240\nWrite-Host done",
      },
    });
    assert.strictEqual(powershell.activity, "PowerShell · Start-Sleep -Seconds 240");
    const command = stats({
      liveTool: { type: "command_execution", title: "Bash", toolName: null, detail: "label 47" },
    });
    assert.strictEqual(command.activity, "Bash · label 47");
    const edit = stats({
      liveTool: { type: "file_change", title: null, toolName: null, detail: "labels/out/47.json" },
    });
    assert.strictEqual(edit.activity, "Edit · labels/out/47.json");
  });

  it("falls back to work left running in the background", () => {
    const sleeping = stats({
      providerThreads: [
        background([]),
        background([
          { kind: "command", taskId: "b1", description: "Sleep 240 seconds in background" },
        ]),
      ],
    });
    assert.strictEqual(sleeping.activity, "Background · Sleep 240 seconds in background");
    const waiting = stats({
      providerThreads: [
        background([{ kind: "subagent", taskId: "s1", description: "Label zone 47" }]),
      ],
    });
    assert.strictEqual(waiting.activity, "Subagent · Label zone 47");
    // A live tool call says more than the background work it may be waiting on.
    const both = stats({
      providerThreads: [background([{ kind: "command", taskId: "b1", description: "sleep" }])],
      liveTool: { type: "command_execution", title: "Bash", toolName: null, detail: "ls" },
    });
    assert.strictEqual(both.activity, "Bash · ls");
  });

  it("has no current activity when nothing runs, in a tool or in the background", () => {
    assert.strictEqual(stats({ providerThreads: [background([])] }).activity, null);
  });

  it("passes the tool call count and the thread's branch, worktree and model through", () => {
    const result = stats({ toolCalls: 41 });
    assert.deepStrictEqual(
      {
        threadId: result.threadId,
        toolCalls: result.toolCalls,
        branch: result.branch,
        worktreePath: result.worktreePath,
        modelSelection: result.modelSelection,
      },
      {
        threadId,
        toolCalls: 41,
        branch: "agent/m4-zones",
        worktreePath: "C:/work/m4",
        modelSelection,
      },
    );
  });
});
