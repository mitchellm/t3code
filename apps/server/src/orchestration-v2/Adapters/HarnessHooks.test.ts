import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  type Ledger,
  LedgerId,
  type LedgerInvestigation,
  type LedgerItem,
  LedgerItemId,
  type Loadout,
  type LoadoutStructure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2HarnessLedgerState,
  ProviderAdapterV2HarnessLoadout,
  ProviderAdapterV2HarnessThreadPolicy,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  buildClaudeHarnessHooks,
  claudePlansDirectory,
  formatLedgerBlock,
  type HarnessHookPort,
  HARNESS_REMINDER_EVERY,
  HARNESS_STOP_BLOCK_CEILING,
  HARNESS_STOP_BLOCK_LIMIT,
  LOADOUT_WITHDRAWN,
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
    ledgerTools: false,
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

  it(`replans after ${HARNESS_STOP_BLOCK_LIMIT} blocks with no ledger change, then allows the stop`, async () => {
    const current = { value: state(ledgerOf([item("L1", "open")])) };
    const { fire } = make(ledgerReader(current));
    const outputs: Array<Record<string, unknown>> = [];
    outputs.push(await fire("Stop", stop(false)));
    for (let index = 0; index <= HARNESS_STOP_BLOCK_LIMIT; index++) {
      outputs.push(await fire("Stop", stop(true)));
    }
    expect(outputs.map((output) => output.decision)).toEqual([
      ...Array.from({ length: HARNESS_STOP_BLOCK_LIMIT + 1 }, () => "block"),
      undefined,
    ]);
    const plain = String(outputs[0]!.reason);
    const replan = String(outputs[HARNESS_STOP_BLOCK_LIMIT]!.reason);
    expect(plain).not.toContain("replan");
    for (const step of ["replan", "split", "acceptance", "blocked", "defer", "L1"]) {
      expect(replan).toContain(step);
    }

    // Progress on the ledger earns a fresh allowance.
    current.value = state(ledgerOf([item("L1", "in_progress"), item("L2", "open")]));
    expect((await fire("Stop", stop(true))).reason).toContain("Ledger has 2 open items");
  });

  it("replans once per stall: progress after the replan starts a new episode", async () => {
    const current = { value: state(ledgerOf([item("L1", "open")])) };
    const { fire } = make(ledgerReader(current));
    for (let index = 0; index < HARNESS_STOP_BLOCK_LIMIT; index++) {
      await fire("Stop", stop(index > 0));
    }
    expect((await fire("Stop", stop(true))).reason).toContain("replan");
    current.value = state(ledgerOf([item("L1", "open"), item("L1.a", "open")]));
    const reasons: Array<unknown> = [];
    for (let index = 0; index <= HARNESS_STOP_BLOCK_LIMIT; index++) {
      reasons.push((await fire("Stop", stop(true))).reason);
    }
    expect(reasons.map((reason) => String(reason).includes("replan"))).toEqual([
      ...Array.from({ length: HARNESS_STOP_BLOCK_LIMIT }, () => false),
      true,
    ]);
    expect(await fire("Stop", stop(true))).toEqual({});
  });

  it(`allows the stop at the ${HARNESS_STOP_BLOCK_CEILING}-block ceiling even when a judge replan is due`, async () => {
    const current: Current = { value: undefined };
    const { fire } = make(ledgerReader(current));
    const judgeFailed = (times: number): LedgerItem => ({
      ...item("L2", "in_progress"),
      judgements: times,
      verdict: {
        outcome: "fail",
        judge: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        notes: "Still wrong",
        at,
      },
    });
    for (let index = 0; index < HARNESS_STOP_BLOCK_CEILING; index++) {
      current.value = state(
        ledgerOf([item("L1", "open", { evidence: `attempt ${index}` }), judgeFailed(1)]),
      );
      expect((await fire("Stop", stop(index > 0))).decision).toBe("block");
    }
    // The third failure lands on the stop that hits the ceiling: the ceiling still wins.
    current.value = state(ledgerOf([item("L1", "open", { evidence: "last" }), judgeFailed(3)]));
    expect(await fire("Stop", stop(true))).toEqual({});
    // The replan was not spent on the allowed stop, so the next prompt gets it.
    expect(String((await fire("Stop", stop(false))).reason)).toContain("failed the judge");
  });

  it("replans an item the judge failed three times, naming it, once per prompt", async () => {
    const failed: LedgerItem = {
      ...item("L2", "in_progress"),
      judgements: 3,
      verdict: {
        outcome: "fail",
        judge: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        notes: "The empty-input case still throws",
        at,
      },
    };
    const current = { value: state(ledgerOf([item("L1", "open"), failed])) };
    const { fire } = make(ledgerReader(current));
    const first = String((await fire("Stop", stop(false))).reason);
    expect(first).toContain("L2");
    expect(first).toContain("failed the judge 3 times");
    expect(first).toContain("The empty-input case still throws");
    expect(String((await fire("Stop", stop(true))).reason)).not.toContain("failed the judge");
    // A new prompt from the user starts a new allowance, replans included.
    expect(String((await fire("Stop", stop(false))).reason)).toContain("failed the judge");
  });

  it(`allows the stop after ${HARNESS_STOP_BLOCK_CEILING} blocks in one prompt even with progress`, async () => {
    const current: Current = { value: undefined };
    const { fire } = make(ledgerReader(current));
    const decisions: Array<unknown> = [];
    for (let index = 0; index <= HARNESS_STOP_BLOCK_CEILING; index++) {
      // Each stop sees a different ledger, so the no-progress limit never trips.
      current.value = state(
        ledgerOf([item("L1", "open", { evidence: `attempt ${index}` }), item("L2", "open")]),
      );
      decisions.push((await fire("Stop", stop(index > 0))).decision);
    }
    expect(decisions).toEqual([
      ...Array.from({ length: HARNESS_STOP_BLOCK_CEILING }, () => "block"),
      undefined,
    ]);
    // The next prompt starts a new allowance.
    expect((await fire("Stop", stop(false))).decision).toBe("block");
  });

  it("gives a new prompt its own allowance", async () => {
    const current = { value: state(ledgerOf([item("L1", "open")])) };
    const { fire } = make(ledgerReader(current));
    // The limit's blocks and its replan.
    for (let index = 0; index <= HARNESS_STOP_BLOCK_LIMIT; index++) {
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

// [plans directory, a plan file inside it, then paths that are not inside it]. The Windows rows mix
// separators and case the way a model's tool input and the host's path module can disagree.
const PLAN_FILES: ReadonlyArray<readonly [string, string, ...Array<string>]> = [
  [
    "C:\\Users\\Mitchell\\.claude\\plans",
    "c:/users/mitchell/.claude/PLANS/quiet-otter.md",
    "C:\\Users\\Mitchell\\workspace\\repo\\src\\app.ts",
    "C:\\Users\\Mitchell\\.claude\\plans\\..\\settings.json",
    "C:\\Users\\Mitchell\\.claude\\plans-old\\stale.md",
    "D:\\Users\\Mitchell\\.claude\\plans\\other-drive.md",
    "plans\\relative.md",
  ],
  [
    "/home/mitchell/.claude/plans",
    "/home/mitchell/.claude/plans/quiet-otter.md",
    "/home/mitchell/repo/src/app.ts",
    "/home/mitchell/.claude/plans/../settings.json",
    "/home/mitchell/.claude/PLANS/case-matters-here.md",
  ],
];

const planModeEdit = (tool: string, filePath: string) =>
  preToolUse(tool, { permission_mode: "plan", tool_input: { file_path: filePath } });

describe("managers structure", () => {
  const structured = (structure: LoadoutStructure | undefined, delegatedChild = false) =>
    make({
      readThreadPolicy: async () =>
        structure === undefined ? undefined : { structure, planBeforeEditing: false },
      delegatedChild,
    });

  it("denies the top-level thread's edits and shell, telling it to delegate", async () => {
    const { fire } = structured("managers");
    for (const tool of [
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
      "PowerShell",
      "REPL",
      "Monitor",
    ]) {
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

  it("denies native workers so the top level cannot route edits around delegate_task", async () => {
    const { fire } = structured("managers");
    for (const tool of ["Agent", "Task", "Workflow"]) {
      const reason = decisionOf(
        await fire("PreToolUse", preToolUse(tool)),
      )?.permissionDecisionReason;
      expect(reason).toContain(tool);
      expect(reason).toContain("delegate_task");
      expect(reason).toContain("role");
    }
    expect(await structured("workers").fire("PreToolUse", preToolUse("Agent"))).toEqual({});
  });

  it("in plan mode, lets a managers thread write its plan file and nothing else", async () => {
    for (const [plansDirectory, planFile, repoFile] of PLAN_FILES) {
      const { fire } = make({
        readThreadPolicy: async () => ({ structure: "managers", planBeforeEditing: false }),
        plansDirectory,
      });
      expect(await fire("PreToolUse", planModeEdit("Write", planFile))).toEqual({});
      const reason = decisionOf(
        await fire("PreToolUse", planModeEdit("Write", repoFile!)),
      )?.permissionDecisionReason;
      expect(reason).toContain("delegate_task");
    }
  });

  it("leaves other structures, delegated children and unreadable state alone", async () => {
    for (const structure of ["solo", "workers", undefined] as const) {
      expect(await structured(structure).fire("PreToolUse", preToolUse("Edit"))).toEqual({});
    }
    expect(await structured("managers", true).fire("PreToolUse", preToolUse("Edit"))).toEqual({});
  });
});

describe("plan before editing", () => {
  const FILE_EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  const gated = (
    current: Current,
    extra: Partial<HarnessHookPort> & {
      policy?: ProviderAdapterV2HarnessThreadPolicy | undefined;
    } = {},
  ) => {
    const { policy, ...port } = extra;
    // An explicit undefined is a failed read, not the default.
    const read =
      "policy" in extra ? policy : { structure: "solo" as const, planBeforeEditing: true };
    return make({
      ...ledgerReader(current),
      readThreadPolicy: async () => read,
      ledgerTools: true,
      ...port,
    });
  };
  const reasonFor = async (fire: ReturnType<typeof make>["fire"], tool: string) =>
    decisionOf(await fire("PreToolUse", preToolUse(tool)))?.permissionDecisionReason;

  it("denies every file edit while the thread has no ledger, asking for the plan first", async () => {
    const { fire } = gated({ value: state(null) });
    for (const tool of FILE_EDIT_TOOLS) {
      const decision = decisionOf(await fire("PreToolUse", preToolUse(tool)));
      expect(decision?.permissionDecision).toBe("deny");
      for (const step of [tool, "ledger_create", "t3_loadout_propose"]) {
        expect(decision?.permissionDecisionReason).toContain(step);
      }
    }
  });

  it("leaves reads, searches, shells and T3 tools alone, so a question needs no ledger", async () => {
    const { fire } = gated({ value: state(null) });
    for (const tool of [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "PowerShell",
      "mcp__t3-code__ledger_create",
    ]) {
      expect(await fire("PreToolUse", preToolUse(tool))).toEqual({});
    }
  });

  it("lifts on the next edit once a ledger opens, and gates again after it closes", async () => {
    const current: Current = { value: state(null) };
    const { fire } = gated(current);
    expect(await reasonFor(fire, "Edit")).toContain("ledger_create");

    current.value = state(ledgerOf([item("L1", "open")]));
    expect(await fire("PreToolUse", preToolUse("Edit"))).toEqual({});
    current.value = state(ledgerOf([item("L1", "in_progress")]));
    expect(await fire("PreToolUse", preToolUse("Write"))).toEqual({});
    // An item awaiting the judge's verdict is still the work in hand.
    current.value = state(ledgerOf([{ ...item("L1", "in_progress"), judging: true }]));
    expect(await fire("PreToolUse", preToolUse("Edit"))).toEqual({});

    current.value = state(ledgerOf([item("L1", "closed")], { closedAt: at }));
    const reason = await reasonFor(fire, "Edit");
    expect(reason).toContain("closed");
    expect(reason).toContain("ledger_create");
  });

  it("treats an open ledger with every item finished as no plan for the next work", async () => {
    const current: Current = {
      value: state(
        ledgerOf([
          item("L1", "closed"),
          { ...item("L2", "dropped"), dropReason: "Not needed" },
          { ...item("L3", "deferred"), deferReason: "Later" },
        ]),
      ),
    };
    const { fire } = gated(current);
    const decision = decisionOf(await fire("PreToolUse", preToolUse("Edit")));
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason).toContain("ledger_add_items");
    expect(decision?.permissionDecisionReason).not.toContain("ledger_create");

    // Adding an item for the new work lifts the gate on the next edit.
    current.value = state(
      ledgerOf([item("L1", "closed"), item("L2", "dropped"), item("L4", "open")]),
    );
    expect(await fire("PreToolUse", preToolUse("Edit"))).toEqual({});
  });

  it("in plan mode, lets the plan file into the plans directory with no ledger", async () => {
    for (const [plansDirectory, planFile] of PLAN_FILES) {
      const { fire } = gated({ value: state(null) }, { plansDirectory });
      for (const tool of ["Write", "Edit", "MultiEdit"]) {
        expect(await fire("PreToolUse", planModeEdit(tool, planFile))).toEqual({});
      }
      // Outside plan mode the plans directory is an ordinary place to edit.
      const outside = preToolUse("Write", { tool_input: { file_path: planFile } });
      expect(decisionOf(await fire("PreToolUse", outside))?.permissionDecision).toBe("deny");
    }
  });

  it("in plan mode, still gates an edit anywhere outside the plans directory", async () => {
    for (const [plansDirectory, , ...elsewhere] of PLAN_FILES) {
      const { fire } = gated({ value: state(null) }, { plansDirectory });
      for (const filePath of elsewhere) {
        const decision = decisionOf(await fire("PreToolUse", planModeEdit("Edit", filePath)));
        expect(decision?.permissionDecision).toBe("deny");
        expect(decision?.permissionDecisionReason).toContain("ledger_create");
      }
      // A notebook carries no file_path, and the plan file is never a notebook.
      const notebook = preToolUse("NotebookEdit", {
        permission_mode: "plan",
        tool_input: { notebook_path: elsewhere[0] },
      });
      expect(decisionOf(await fire("PreToolUse", notebook))?.permissionDecision).toBe("deny");
    }
    // With no known plans directory, nothing is exempt.
    const { fire } = gated({ value: state(null) });
    const [, planFile] = PLAN_FILES[0]!;
    expect(
      decisionOf(await fire("PreToolUse", planModeEdit("Write", planFile)))?.permissionDecision,
    ).toBe("deny");
  });

  it("after an ended investigation, says edits wait for the user's next message", async () => {
    const investigation: LedgerInvestigation = {
      goal: "Why does the build flake",
      solvedWhen: "A cause reproduces on demand",
      budget: { minutes: 30 },
      parallelApproaches: 4,
      status: "stopped",
      approachesItemId: LedgerItemId.make("L1"),
      startedAt: at,
      endedAt: at,
    };
    const ended = [
      ledgerOf([item("L1", "closed")], { investigation }),
      ledgerOf([item("L1", "closed")], { investigation, closedAt: at }),
    ];
    for (const ledger of ended) {
      const reason = await reasonFor(gated({ value: state(ledger) }).fire, "Edit");
      expect(reason).toContain("investigation");
      expect(reason).toContain("next message");
      expect(reason).not.toContain("ledger_create");
      expect(reason).not.toContain("ledger_add_items");
    }
  });

  it("tells a native subagent to report back instead of planning for the thread", async () => {
    const { fire } = gated({ value: state(null) });
    const decision = decisionOf(await fire("PreToolUse", preToolUse("Edit", { agent_id: "sub" })));
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason).toContain("report");
    expect(decision?.permissionDecisionReason).not.toContain("t3_loadout_propose");
  });

  it("never gates a delegated child thread", async () => {
    const { fire } = gated({ value: state(null) }, { delegatedChild: true });
    for (const tool of FILE_EDIT_TOOLS) {
      expect(await fire("PreToolUse", preToolUse(tool))).toEqual({});
    }
  });

  it("allows edits when the setting is off or a read fails", async () => {
    const off = { structure: "solo" as const, planBeforeEditing: false };
    for (const policy of [off, undefined]) {
      expect(
        await gated({ value: state(null) }, { policy }).fire("PreToolUse", preToolUse("Edit")),
      ).toEqual({});
    }
    expect(await gated({ value: undefined }).fire("PreToolUse", preToolUse("Edit"))).toEqual({});
    const { fire, errors } = gated(
      { value: state(null) },
      {
        readThreadPolicy: async () => {
          throw new Error("settings unavailable");
        },
      },
    );
    expect(await fire("PreToolUse", preToolUse("Edit"))).toEqual({});
    expect(errors).toHaveLength(1);
  });

  it("is off without the T3 tools, so a session that cannot write a ledger is never stranded", async () => {
    const { fire } = gated({ value: state(null) }, { ledgerTools: false });
    expect(await fire("PreToolUse", preToolUse("Edit"))).toEqual({});
  });

  it("leaves a managers loadout's stricter denial in charge", async () => {
    const { fire } = gated(
      { value: state(null) },
      { policy: { structure: "managers", planBeforeEditing: true } },
    );
    expect(await reasonFor(fire, "Edit")).toContain("delegate_task");
    expect(await reasonFor(fire, "Bash")).toContain("delegate_task");
  });

  it("reads the thread policy once per gated call, and the ledger only for an edit", async () => {
    const reads = { policy: 0, ledger: 0 };
    let structure: LoadoutStructure = "solo";
    const { fire } = make({
      readThreadPolicy: async () => {
        reads.policy++;
        return { structure, planBeforeEditing: true };
      },
      readLedgerState: async () => {
        reads.ledger++;
        return state(null);
      },
      ledgerTools: true,
    });
    await fire("PreToolUse", preToolUse("Read"));
    expect(reads).toEqual({ policy: 0, ledger: 0 });
    await fire("PreToolUse", preToolUse("Bash"));
    expect(reads).toEqual({ policy: 1, ledger: 0 });
    await fire("PreToolUse", preToolUse("Edit"));
    expect(reads).toEqual({ policy: 2, ledger: 1 });
    // A managers denial needs no ledger.
    structure = "managers";
    await fire("PreToolUse", preToolUse("Edit"));
    expect(reads).toEqual({ policy: 3, ledger: 1 });
  });
});

const claudeAgent = ProviderInstanceId.make("claudeAgent");
const oversight: Loadout = {
  id: "oversight",
  name: "Oversight",
  description: "Not shown to the agent.",
  roles: {
    planner: {
      instanceId: ProviderInstanceId.make("superbot"),
      model: "superbot-1",
      effort: "high",
    },
    explorer: { instanceId: claudeAgent, model: "claude-haiku-5-5" },
    worker: { instanceId: claudeAgent, model: "claude-sonnet-5-5" },
    judge: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: { instanceId: claudeAgent, model: "claude-opus-5-5", effort: "high" },
    },
  },
};
const oversightLoadout: ProviderAdapterV2HarnessLoadout = { ...oversight, setBy: "user" };
const prompt = (): HookInput => ({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" });

interface CurrentLoadout {
  value: ProviderAdapterV2HarnessLoadout | null | undefined;
}

const withLoadout = (current: CurrentLoadout, port: Partial<HarnessHookPort> = {}) => {
  const reads = { loadout: 0 };
  return {
    reads,
    ...make({
      readLoadout: async () => {
        reads.loadout++;
        return current.value;
      },
      ledgerTools: true,
      ...port,
    }),
  };
};

describe("loadout context", () => {
  it("tells the agent its loadout: roles with model and effort, the judge's fallback, how to use it", async () => {
    const { fire } = withLoadout({ value: oversightLoadout });
    expect(contextOf(await fire("UserPromptSubmit", prompt()))).toBe(
      [
        'Loadout: "Oversight", set by the user. Structure: workers.',
        "Roles:",
        "- planner (the top-level thread, you): superbot-1 on superbot, effort high",
        "- explorer: claude-haiku-5-5 on claudeAgent",
        "- worker: claude-sonnet-5-5 on claudeAgent",
        "- judge: gpt-6.1-sol on codex, effort high; falls back to claude-opus-5-5 on claudeAgent, effort high",
        "How far to fan out is your call. Write the ledger and plan each item, small ones yourself and unclear ones through an explorer; add, split or drop items as you learn. Send independent items to workers in parallel with delegate_task, a role and the item's ledgerItemId, and do small ones yourself. When ledger_read shows requiresJudge, closing an item with ledger_update_item starts the judge, and the item closes when it passes.",
      ].join("\n"),
    );
  });

  it("sends the block on a session's first prompt, then only when it changes", async () => {
    const current: CurrentLoadout = { value: oversightLoadout };
    const { fire } = withLoadout(current);
    expect(contextOf(await fire("UserPromptSubmit", prompt()))).toContain('"Oversight"');
    // Task notifications and auto-continue arrive as prompts too; an unchanged loadout is not repeated.
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});

    // The agent proposes a managers loadout with no roles mid-thread; the next prompt says so.
    current.value = {
      ...oversight,
      name: "Lean",
      roles: {},
      structure: "managers",
      setBy: "agent",
    };
    const next = contextOf(await fire("UserPromptSubmit", prompt())) ?? "";
    expect(next).toContain('Loadout: "Lean", proposed by you. Structure: managers.');
    expect(next).toContain("Roles: none assigned");
    expect(next).toContain(
      "You plan and review only: delegate every edit and shell command with delegate_task and a role (worker or subPlanner). Pass each task the ledgerItemId of the item it works on.",
    );
    expect(next).not.toContain("explorer");
    expect(next).not.toContain("judge");
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
  });

  it("withdraws the loadout once when the thread goes back to solo, and after each compaction", async () => {
    const current: CurrentLoadout = { value: oversightLoadout };
    const { fire } = withLoadout(current);
    await fire("UserPromptSubmit", prompt());
    current.value = null;
    expect(contextOf(await fire("UserPromptSubmit", prompt()))).toBe(LOADOUT_WITHDRAWN);
    expect(LOADOUT_WITHDRAWN).toBe(
      "This thread now runs solo; the earlier loadout no longer applies.",
    );
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
    // The summary may still carry the old loadout's gist, so a compaction withdraws it again.
    expect(contextOf(await fire("SessionStart", compact()))).toBe(LOADOUT_WITHDRAWN);
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
    // A loadout chosen again is shown again.
    current.value = oversightLoadout;
    expect(contextOf(await fire("UserPromptSubmit", prompt()))).toContain('"Oversight"');
  });

  it("says nothing on a thread that never had a loadout, even after a compaction", async () => {
    const { fire } = withLoadout({ value: null });
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
    expect(await fire("SessionStart", compact())).toEqual({});
  });

  it("skips the loadout without the T3 tools, since its roles are reached only through them", async () => {
    const { fire, reads } = withLoadout({ value: oversightLoadout }, { ledgerTools: false });
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
    expect(await fire("SessionStart", compact())).toEqual({});
    expect(reads.loadout).toBe(0);
  });

  it("adds nothing when a read fails, reports it, and keeps the last block as sent", async () => {
    const current: CurrentLoadout = { value: undefined };
    const { fire } = withLoadout(current);
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
    current.value = oversightLoadout;
    await fire("UserPromptSubmit", prompt());
    current.value = undefined;
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
    current.value = oversightLoadout;
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});

    const failure = new Error("settings unavailable");
    const failing = make({
      readLoadout: async () => {
        throw failure;
      },
      ledgerTools: true,
    });
    expect(await failing.fire("UserPromptSubmit", prompt())).toEqual({});
    expect(failing.errors).toEqual([failure]);
  });

  it("reaches a delegated child only through the child thread's own loadout", async () => {
    // A child thread is created without a loadout, so its own read is solo.
    const plain = withLoadout({ value: null }, { delegatedChild: true });
    expect(await plain.fire("UserPromptSubmit", prompt())).toEqual({});
    const own = withLoadout({ value: oversightLoadout }, { delegatedChild: true });
    expect(contextOf(await own.fire("UserPromptSubmit", prompt()))).toContain(
      'Loadout: "Oversight"',
    );
  });

  it("re-sends the loadout after a compaction, alongside the ledger", async () => {
    const { fire } = withLoadout(
      { value: oversightLoadout },
      { readLedgerState: async () => state(ledgerOf([item("L1", "open")])) },
    );
    const block = contextOf(await fire("UserPromptSubmit", prompt()))!;
    const context = contextOf(await fire("SessionStart", compact())) ?? "";
    expect(context).toContain("L1 Item L1");
    expect(context).toContain(block);
    // The compaction re-sent it, so the next prompt does not.
    expect(await fire("UserPromptSubmit", prompt())).toEqual({});
  });
});

describe("claudePlansDirectory", () => {
  it("is the session's plansDirectory from the project root, else plans under the Claude home", () => {
    const claudeHome = NodePath.resolve("claude-home");
    const cwd = NodePath.resolve("repo");
    for (const configured of [undefined, "", "  "]) {
      expect(claudePlansDirectory({ claudeHome, cwd, configured })).toBe(
        NodePath.join(claudeHome, "plans"),
      );
    }
    expect(claudePlansDirectory({ claudeHome, cwd, configured: "docs/plans" })).toBe(
      NodePath.resolve(cwd, "docs/plans"),
    );
    const absolute = NodePath.resolve("elsewhere", "plans");
    expect(claudePlansDirectory({ claudeHome, cwd, configured: absolute })).toBe(absolute);
  });
});

describe("registration", () => {
  it("registers nothing without any reader", () => {
    expect(make({}).hooks).toBeUndefined();
  });
});
