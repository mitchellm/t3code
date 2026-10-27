// Fork: the numbers on the ledger's agent card, derived from a delegated task's own thread.
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  TaskStats,
} from "@t3tools/contracts";

/** The turn items that are a tool call; the service reads only these, so messages stay unread. */
export const TASK_STATS_TOOL_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

type ToolItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: (typeof TASK_STATS_TOOL_ITEM_TYPES)[number] }
>;

const TOOL_TYPES: ReadonlySet<string> = new Set(TASK_STATS_TOOL_ITEM_TYPES);
const MAX_ACTIVITY_LENGTH = 160;

const isToolItem = (item: OrchestrationV2TurnItem): item is ToolItem => TOOL_TYPES.has(item.type);

const isLive = (status: OrchestrationV2TurnItem["status"]) =>
  status === "pending" || status === "running" || status === "waiting";

const firstLine = (value: string | undefined) => value?.trim().split("\n", 1)[0]?.trim() ?? "";

function toolDetail(item: ToolItem): { readonly verb: string; readonly detail: string } {
  switch (item.type) {
    case "command_execution":
      return { verb: "Command", detail: firstLine(item.input) };
    case "file_change":
      return { verb: "Edit", detail: item.fileName };
    case "file_search":
      return { verb: "Search", detail: firstLine(item.pattern) };
    case "web_search":
      return { verb: "Web search", detail: firstLine(item.patterns?.[0]) };
    case "dynamic_tool":
      return { verb: item.toolName ?? "Tool", detail: "" };
  }
}

/** "PowerShell · label-zone.ps1 -Zone 47": the tool's title, then what it is working on. */
function describeActivity(item: ToolItem): string {
  const { verb, detail } = toolDetail(item);
  const title = item.title?.trim() || verb;
  const parts = detail === "" || detail === title ? [title] : [title, detail];
  const text = parts.join(" · ").replace(/\s+/gu, " ");
  return text.length > MAX_ACTIVITY_LENGTH
    ? `${text.slice(0, MAX_ACTIVITY_LENGTH - 1).trimEnd()}…`
    : text;
}

export function deriveTaskStats(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "branch" | "worktreePath">;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "tokenUsage" | "turnTokenUsage">
  >;
  readonly toolItems: ReadonlyArray<OrchestrationV2TurnItem>;
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

  let toolCalls = 0;
  let current: ToolItem | null = null;
  for (const item of input.toolItems) {
    if (!isToolItem(item)) continue;
    toolCalls += 1;
    if (isLive(item.status) && (current === null || item.ordinal > current.ordinal)) {
      current = item;
    }
  }

  return {
    threadId: input.thread.id,
    tokens: reported ? { input: inputTokens, output: outputTokens } : null,
    toolCalls,
    activity: current === null ? null : describeActivity(current),
    branch: input.thread.branch,
    worktreePath: input.thread.worktreePath,
  };
}
