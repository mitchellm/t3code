// Fork: the numbers on the ledger's agent card, derived from a delegated task's own thread.
import type {
  OrchestrationV2AppThread,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  TaskStats,
} from "@t3tools/contracts";

/** The turn item types that are a tool call; only these are counted, never messages. */
export const TASK_STATS_TOOL_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

/** The latest tool call still running, as the service's one-row read gives it. */
export interface TaskStatsLiveTool {
  readonly type: string;
  readonly title: string | null;
  readonly toolName: string | null;
  /** What the call works on: a command, a file, a pattern or a tool argument. */
  readonly detail: string | null;
}

const MAX_ACTIVITY_LENGTH = 160;

const TOOL_VERB: Record<string, string> = {
  command_execution: "Command",
  file_change: "Edit",
  file_search: "Search",
  web_search: "Web search",
  dynamic_tool: "Tool",
};

const BACKGROUND_LABEL: Record<string, string> = {
  subagent: "Subagent",
  monitor: "Monitor",
};

const firstLine = (value: string | null | undefined) =>
  value?.trim().split("\n", 1)[0]?.trim() ?? "";

/** "PowerShell · Start-Sleep -Seconds 240": what is running, then what it is working on. */
function describe(name: string, detail: string | null | undefined): string {
  const line = firstLine(detail);
  const text = (line === "" || line === name ? name : `${name} · ${line}`).replace(/\s+/gu, " ");
  return text.length > MAX_ACTIVITY_LENGTH
    ? `${text.slice(0, MAX_ACTIVITY_LENGTH - 1).trimEnd()}…`
    : text;
}

function describeLiveTool(tool: TaskStatsLiveTool): string {
  const name = tool.title?.trim() || tool.toolName?.trim() || TOOL_VERB[tool.type] || "Tool";
  return describe(name, tool.detail);
}

function describeBackground(task: OrchestrationV2PendingBackgroundTask): string {
  return describe(BACKGROUND_LABEL[task.kind] ?? "Background", task.description);
}

export function deriveTaskStats(input: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "id" | "branch" | "worktreePath" | "modelSelection"
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "tokenUsage" | "turnTokenUsage">
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "pendingBackgroundTasks">
  >;
  readonly toolCalls: number;
  readonly liveTool: TaskStatsLiveTool | null;
}): TaskStats {
  let reported = false;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const turn of input.providerTurns) {
    // A turn's own usage when the provider reports it, else the context snapshot it left.
    const turnInput = turn.turnTokenUsage?.inputTokens ?? turn.tokenUsage?.inputTokens;
    const turnOutput = turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens;
    if (turnInput === undefined && turnOutput === undefined) continue;
    reported = true;
    inputTokens += turnInput ?? 0;
    outputTokens += turnOutput ?? 0;
  }

  // A long command the agent moved to the background leaves no live tool call behind, only
  // the pending task its turn is waiting on.
  const background = input.providerThreads
    .flatMap((providerThread) => providerThread.pendingBackgroundTasks ?? [])
    .at(-1);

  return {
    threadId: input.thread.id,
    tokens: reported ? { input: inputTokens, output: outputTokens } : null,
    toolCalls: input.toolCalls,
    activity:
      input.liveTool !== null
        ? describeLiveTool(input.liveTool)
        : background === undefined
          ? null
          : describeBackground(background),
    branch: input.thread.branch,
    worktreePath: input.thread.worktreePath,
    modelSelection: input.thread.modelSelection,
  };
}
