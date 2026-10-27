import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveTaskStats } from "./TaskStats.ts";

const threadId = ThreadId.make("thread:worker");
const now = DateTime.makeUnsafe(Date.UTC(2026, 9, 27));

const base = (
  ordinal: number,
  status: OrchestrationV2TurnItem["status"],
  title: string | null,
) => ({
  id: TurnItemId.make(`item:${ordinal}`),
  threadId,
  runId: RunId.make("run:1"),
  nodeId: NodeId.make(`node:${ordinal}`),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status,
  title,
  startedAt: now,
  completedAt: status === "running" ? null : now,
  updatedAt: now,
});

const command = (
  ordinal: number,
  status: OrchestrationV2TurnItem["status"],
  input: string,
  title: string | null = "PowerShell",
): OrchestrationV2TurnItem => ({
  ...base(ordinal, status, title),
  type: "command_execution",
  input,
});

const edit = (ordinal: number, status: OrchestrationV2TurnItem["status"], fileName: string) =>
  ({ ...base(ordinal, status, null), type: "file_change", fileName }) as OrchestrationV2TurnItem;

const message = (ordinal: number): OrchestrationV2TurnItem => ({
  ...base(ordinal, "running", null),
  type: "assistant_message",
  messageId: "message:1" as never,
  text: "Working on it",
  streaming: true,
});

const turn = (
  usage: Pick<OrchestrationV2ProviderTurn, "tokenUsage" | "turnTokenUsage">,
): Pick<OrchestrationV2ProviderTurn, "tokenUsage" | "turnTokenUsage"> => usage;

const thread = { id: threadId, branch: "agent/m4-zones", worktreePath: "C:/work/m4" };

describe("deriveTaskStats", () => {
  it("totals each turn's tokens, falling back to the context snapshot a turn reported", () => {
    const stats = deriveTaskStats({
      thread,
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
      toolItems: [],
    });
    assert.deepStrictEqual(stats.tokens, { input: 160_000, output: 22_000 });
  });

  it("has no token total when no turn reported usage", () => {
    const stats = deriveTaskStats({ thread, providerTurns: [turn({})], toolItems: [] });
    assert.strictEqual(stats.tokens, null);
  });

  it("counts tool calls and nothing else", () => {
    const stats = deriveTaskStats({
      thread,
      providerTurns: [],
      toolItems: [
        command(1, "completed", "ls"),
        edit(2, "completed", "src/a.ts"),
        message(3),
        command(4, "failed", "vp test"),
      ],
    });
    assert.strictEqual(stats.toolCalls, 3);
  });

  it("names the latest tool call still running as the current activity", () => {
    const stats = deriveTaskStats({
      thread,
      providerTurns: [],
      toolItems: [
        command(1, "running", "label-zone.ps1 -Zone 46"),
        command(2, "completed", "label-zone.ps1 -Zone 45"),
        command(3, "running", "label-zone.ps1 -Zone 47\nWrite-Host done"),
        message(4),
      ],
    });
    assert.strictEqual(stats.activity, "PowerShell · label-zone.ps1 -Zone 47");
    const editing = deriveTaskStats({
      thread,
      providerTurns: [],
      toolItems: [edit(5, "running", "labels/out/47.json")],
    });
    assert.strictEqual(editing.activity, "Edit · labels/out/47.json");
  });

  it("has no current activity once every tool call settled", () => {
    const stats = deriveTaskStats({
      thread,
      providerTurns: [],
      toolItems: [command(1, "completed", "ls"), command(2, "interrupted", "sleep 100")],
    });
    assert.strictEqual(stats.activity, null);
  });

  it("reports the child thread's branch and worktree", () => {
    const stats = deriveTaskStats({ thread, providerTurns: [], toolItems: [] });
    assert.deepStrictEqual(
      { threadId: stats.threadId, branch: stats.branch, worktreePath: stats.worktreePath },
      { threadId, branch: "agent/m4-zones", worktreePath: "C:/work/m4" },
    );
  });
});
