import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  type Ledger,
  LedgerId,
  type LedgerItem,
  LedgerItemId,
  type LoadoutStructure,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2HarnessLedgerState } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildClaudeHarnessHooks,
  formatLedgerBlock,
  type HarnessHookPort,
  HARNESS_REMINDER_EVERY,
  HARNESS_STOP_BLOCK_LIMIT,
} from "./HarnessHooks.ts";

const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 26));

const item = (
  id: string,
  status: LedgerItem["status"],
  extra: Partial<Pick<LedgerItem, "title" | "acceptance" | "evidence">> = {},
): LedgerItem => ({
  id: LedgerItemId.make(id),
  title: extra.title ?? `Item ${id}`,
  acceptance: extra.acceptance ?? `${id} works`,
  status,
  evidence: extra.evidence ?? null,
  dropReason: null,
  verdict: null,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
});

const ledgerOf = (items: ReadonlyArray<LedgerItem>, extra: Partial<Ledger> = {}): Ledger => ({
  id: LedgerId.make("ledger:hooks"),
  threadId: ThreadId.make("thread:hooks"),
  title: "Ship the hooks",
  startState: "nothing",
  checkpoints: [],
  winConditions: ["Stop blocks with open items", "Compaction keeps the ledger"],
  items,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
  ...extra,
});

const state = (
  ledger: Ledger | null,
  extra: Partial<ProviderAdapterV2HarnessLedgerState> = {},
): ProviderAdapterV2HarnessLedgerState => ({
  ledger,
  userInterrupted: false,
  delegatedWorkActive: false,
  ...extra,
});

const base = { session_id: "s", transcript_path: "t", cwd: "/workspace" };

const make = (port: Partial<HarnessHookPort>) => {
  const errors: Array<unknown> = [];
  const hooks = buildClaudeHarnessHooks({
    openedWithPinnedRules: false,
    delegatedChild: false,
    onHookError: (cause) => errors.push(cause),
    ...port,
  });
  const fire = async (
    event: keyof NonNullable<typeof hooks>,
    input: HookInput,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<HookJSONOutput & Record<string, unknown>> => {
    const matcher = hooks?.[event]?.[0];
    if (matcher === undefined) return {};
    if (matcher.matcher !== undefined) {
      const subject =
        "tool_name" in input ? input.tool_name : "source" in input ? input.source : undefined;
      if (subject !== undefined && !new RegExp(`^(${matcher.matcher})$`).test(subject)) return {};
    }
    return (await matcher.hooks[0]!(input, undefined, { signal })) as HookJSONOutput &
      Record<string, unknown>;
  };
  return { hooks, fire, errors };
};

const stop = (stopHookActive: boolean, extra: Record<string, unknown> = {}): HookInput => ({
  ...base,
  hook_event_name: "Stop",
  stop_hook_active: stopHookActive,
  ...extra,
});

interface Current {
  value: ProviderAdapterV2HarnessLedgerState | undefined;
}

const ledgerReader = (current: Current) => ({
  readLedgerState: async () => current.value,
});

describe("Stop hook", () => {
  it("blocks a stop while the ledger has open items, naming the next ones", async () => {
    const current = {
      value: state(ledgerOf([item("L1", "closed"), item("L3", "in_progress"), item("L4", "open")])),
    };
    const { fire } = make(ledgerReader(current));
    const output = await fire("Stop", stop(false));
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("Ledger has 2 open items");
    expect(output.reason).toContain("L3 Item L3");
    expect(output.reason).toContain("L4 Item L4");
    expect(output.reason).not.toContain("L1");
    expect(output.reason).toContain("close with evidence, or drop with a reason");
  });

  it("allows the stop when nothing is open, or the ledger is closed or absent", async () => {
    const current: Current = {
      value: state(ledgerOf([item("L1", "closed"), item("L2", "dropped")])),
    };
    const { fire } = make(ledgerReader(current));
    expect(await fire("Stop", stop(false))).toEqual({});
    current.value = state(ledgerOf([item("L1", "open")], { closedAt: at }));
    expect(await fire("Stop", stop(false))).toEqual({});
    current.value = state(null);
    expect(await fire("Stop", stop(false))).toEqual({});
    current.value = undefined;
    expect(await fire("Stop", stop(false))).toEqual({});
  });

  it(`allows the stop after ${HARNESS_STOP_BLOCK_LIMIT} blocks with no ledger change`, async () => {
    const current = { value: state(ledgerOf([item("L1", "open")])) };
    const { fire } = make(ledgerReader(current));
    const decisions: Array<unknown> = [];
    decisions.push((await fire("Stop", stop(false))).decision);
    for (let index = 0; index < HARNESS_STOP_BLOCK_LIMIT; index++) {
      decisions.push((await fire("Stop", stop(true))).decision);
    }
    expect(decisions).toEqual([
      ...Array.from({ length: HARNESS_STOP_BLOCK_LIMIT }, () => "block"),
      undefined,
    ]);

    // Progress on the ledger earns a fresh allowance.
    current.value = state(ledgerOf([item("L1", "in_progress"), item("L2", "open")]));
    expect((await fire("Stop", stop(true))).decision).toBe("block");
  });

  it("gives a new prompt its own allowance", async () => {
    const current = { value: state(ledgerOf([item("L1", "open")])) };
    const { fire } = make(ledgerReader(current));
    for (let index = 0; index < HARNESS_STOP_BLOCK_LIMIT; index++) {
      await fire("Stop", stop(index > 0));
    }
    expect(await fire("Stop", stop(true))).toEqual({});
    expect((await fire("Stop", stop(false))).decision).toBe("block");
  });

  it("allows the stop when the user interrupted", async () => {
    const current = { value: state(ledgerOf([item("L1", "open")]), { userInterrupted: true }) };
    const { fire } = make(ledgerReader(current));
    expect(await fire("Stop", stop(false))).toEqual({});

    current.value = state(ledgerOf([item("L1", "open")]));
    const controller = new AbortController();
    controller.abort();
    expect(await fire("Stop", stop(false), controller.signal)).toEqual({});
  });

  it("allows the stop while a delegated task or a background subagent is working", async () => {
    const current = {
      value: state(ledgerOf([item("L1", "open")]), { delegatedWorkActive: true }),
    };
    const { fire } = make(ledgerReader(current));
    expect(await fire("Stop", stop(false))).toEqual({});

    current.value = state(ledgerOf([item("L1", "open")]));
    const waiting = stop(false, {
      background_tasks: [{ id: "a1", type: "subagent", status: "running", description: "review" }],
    });
    expect(await fire("Stop", waiting)).toEqual({});
    expect((await fire("Stop", stop(false))).decision).toBe("block");
  });

  it("never throws: a failed read allows the stop and is reported", async () => {
    const failure = new Error("database unavailable");
    const { fire, errors } = make({
      readLedgerState: async () => {
        throw failure;
      },
    });
    expect(await fire("Stop", stop(false))).toEqual({});
    expect(errors).toEqual([failure]);
  });
});

const compact = (): HookInput => ({ ...base, hook_event_name: "SessionStart", source: "compact" });
const contextOf = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

describe("compaction", () => {
  it("re-injects the pinned rules and the ledger block verbatim after a compaction", async () => {
    const rules = "Never touch generated/ files.\nAlways run `vp test` first.";
    const ledger = ledgerOf([
      item("L1", "closed"),
      item("L3", "in_progress", {
        title: "Wire the Stop hook",
        acceptance: "Stop blocks with `open` items; tests in HarnessHooks.test.ts pass",
      }),
      item("L4", "open", { title: "Compaction block" }),
    ]);
    const { fire } = make({
      readPinnedRules: async () => rules,
      readLedgerState: async () => state(ledger),
    });
    const context = contextOf(await fire("SessionStart", compact())) ?? "";
    expect(context).toContain(rules);
    expect(context).toContain(formatLedgerBlock(ledger)!);
    expect(context).toContain("Ship the hooks");
    expect(context).toContain("Compaction keeps the ledger");
    expect(context).toContain(
      "L3 Wire the Stop hook\nAcceptance: Stop blocks with `open` items; tests in HarnessHooks.test.ts pass",
    );
    expect(context).toContain("L4 Compaction block");
    expect(context).not.toContain("L1 ");
    const startup: HookInput = { ...base, hook_event_name: "SessionStart", source: "startup" };
    expect(contextOf(await fire("SessionStart", startup))).toBe(undefined);
  });

  it("re-injects the ledger alone when there are no rules, and nothing without a ledger", async () => {
    const current = { value: state(ledgerOf([item("L1", "open")])) };
    const { fire } = make({ readPinnedRules: async () => "", ...ledgerReader(current) });
    const context = contextOf(await fire("SessionStart", compact())) ?? "";
    expect(context).toContain("L1 Item L1");
    expect(context).not.toContain("pinned rules");
    current.value = state(null);
    expect(await fire("SessionStart", compact())).toEqual({});
  });

  it("caps the ledger block", () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      item(`L${index}`, "open", { title: `A long item title ${"x".repeat(200)} ${index}` }),
    );
    const block = formatLedgerBlock(ledgerOf(many)) ?? "";
    expect(block.length).toBeLessThanOrEqual(3_000);
    expect(block).toContain("more");
  });

  it("asks the compaction to keep the in-progress and open items", async () => {
    const { fire } = make({
      readLedgerState: async () => state(ledgerOf([item("L3", "in_progress"), item("L4", "open")])),
    });
    const output = await fire("PreCompact", {
      ...base,
      hook_event_name: "PreCompact",
      trigger: "auto",
      custom_instructions: null,
    });
    expect(output.systemMessage).toContain("L3");
    expect(output.systemMessage).toContain("L4");
  });
});

const toolUse = (toolName: string, extra: Record<string, unknown> = {}): HookInput => ({
  ...base,
  hook_event_name: "PostToolUse",
  tool_name: toolName,
  tool_input: {},
  tool_response: {},
  tool_use_id: "tool",
  ...extra,
});

describe("PostToolUse reminder", () => {
  it(`reminds the agent of the ledger every ${HARNESS_REMINDER_EVERY} tool calls`, async () => {
    let reads = 0;
    const { fire } = make({
      readLedgerState: async () => {
        reads++;
        return state(ledgerOf([item("L3", "in_progress"), item("L4", "open")]));
      },
    });
    const reminders: Array<number> = [];
    for (let call = 1; call <= HARNESS_REMINDER_EVERY * 2; call++) {
      const context = contextOf(await fire("PostToolUse", toolUse("Read")));
      if (context !== undefined) {
        reminders.push(call);
        expect(context).toContain("L3 Item L3");
        expect(context).toContain("2 open");
        expect(context.split("\n")).toHaveLength(1);
      }
    }
    expect(reminders).toEqual([HARNESS_REMINDER_EVERY, HARNESS_REMINDER_EVERY * 2]);
    expect(reads).toBe(2);
  });

  it("does not count a native subagent's tool calls", async () => {
    const { fire } = make({
      readLedgerState: async () => state(ledgerOf([item("L3", "in_progress")])),
    });
    for (let call = 1; call <= HARNESS_REMINDER_EVERY; call++) {
      expect(await fire("PostToolUse", toolUse("Read", { agent_id: "sub" }))).toEqual({});
    }
  });
});

const preToolUse = (toolName: string, extra: Record<string, unknown> = {}): HookInput => ({
  ...base,
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: {},
  tool_use_id: "tool",
  ...extra,
});
const decisionOf = (output: Record<string, unknown>) =>
  output.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined;

describe("managers structure", () => {
  const structured = (structure: LoadoutStructure | undefined, delegatedChild = false) =>
    make({ readStructure: async () => structure, delegatedChild });

  it("denies the top-level thread's edits and shell, telling it to delegate", async () => {
    const { fire } = structured("managers");
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
      const decision = decisionOf(await fire("PreToolUse", preToolUse(tool)));
      expect(decision?.permissionDecision).toBe("deny");
      expect(decision?.permissionDecisionReason).toContain("delegate_task");
      expect(decision?.permissionDecisionReason).toContain("worker");
    }
    expect(
      decisionOf(await fire("PreToolUse", preToolUse("Bash")))?.permissionDecisionReason,
    ).toContain("Bash");
    expect(await fire("PreToolUse", preToolUse("Read"))).toEqual({});
    expect(await fire("PreToolUse", preToolUse("mcp__t3-code__delegate_task"))).toEqual({});
  });

  it("leaves other structures, delegated children and unreadable state alone", async () => {
    for (const structure of ["solo", "workers", undefined] as const) {
      expect(await structured(structure).fire("PreToolUse", preToolUse("Edit"))).toEqual({});
    }
    expect(await structured("managers", true).fire("PreToolUse", preToolUse("Edit"))).toEqual({});
  });
});

describe("registration", () => {
  it("registers nothing without any reader", () => {
    expect(make({}).hooks).toBeUndefined();
  });
});
