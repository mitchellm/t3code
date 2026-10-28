import { describe, expect, it } from "@effect/vitest";
import {
  type Ledger,
  LedgerCheckpointId,
  LedgerId,
  LedgerItemId,
  NodeId,
  type OrchestrationV2Run,
  PlanId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { FENCE_BEGIN } from "../mcp/LedgerJudgement.ts";
import { isReservedCommandId } from "./reservedCommandIds.ts";
import {
  BUILD_LEDGER_TEXT,
  auditCommands,
  auditPrompt,
  buildCommands,
  buildMessageText,
  buildModeRefusal,
  buildSubject,
  parseAuditFindings,
  resetSeedText,
} from "./BuildMode.ts";

const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const threadId = ThreadId.make("thread:planning");
const plan = { id: PlanId.make("plan:1"), threadId, markdown: "# Ship it\n\n- step one\n" };

const item = (id: string, title: string, status: Ledger["items"][number]["status"]) => ({
  id: LedgerItemId.make(id),
  title,
  acceptance: `${title} passes its test`,
  status,
  evidence: null,
  dropReason: null,
  verdict: null,
  createdAt: at,
  updatedAt: at,
  closedAt: status === "closed" ? at : null,
});

const ledger: Ledger = {
  id: LedgerId.make("ledger:1"),
  threadId,
  title: "Port the parser",
  startState: "Parser is hand-written",
  checkpoints: [
    { id: LedgerCheckpointId.make("cp:1"), title: "Grammar drafted", reached: true, reachedAt: at },
    {
      id: LedgerCheckpointId.make("cp:2"),
      title: "Old parser removed",
      reached: false,
      reachedAt: null,
    },
  ],
  winConditions: ["All fixtures parse", "No regressions in CI"],
  items: [
    item("i1", "Write grammar", "closed"),
    item("i2", "Generate parser", "in_progress"),
    item("i3", "Swap call sites", "open"),
    item("i4", "Benchmark", "dropped"),
  ],
  createdAt: at,
  updatedAt: at,
  closedAt: null,
};

const loadout = { name: "Deep", roles: "Opus xhigh plans · Haiku works · Opus judges" };

describe("resetSeedText", () => {
  it("carries the open work, checkpoints, win conditions and loadout, then the build message", () => {
    expect(resetSeedText({ ledger, loadout, buildText: BUILD_LEDGER_TEXT })).toBe(
      [
        "This is a fresh session on an existing thread. The earlier conversation is not in your context; the user can still see it. What carries over is below.",
        "",
        "## Task ledger: Port the parser",
        "Started from: Parser is hand-written",
        "Win conditions:",
        "- All fixtures parse",
        "- No regressions in CI",
        "Checkpoints:",
        "- [x] Grammar drafted",
        "- [ ] Old parser removed",
        "Open items:",
        "- i2 Generate parser (in progress)",
        "  Done when: Generate parser passes its test",
        "- i3 Swap call sites",
        "  Done when: Swap call sites passes its test",
        "Already settled: 1 closed, 1 dropped.",
        "",
        "## Loadout: Deep",
        "Opus xhigh plans · Haiku works · Opus judges. Hand worker, explorer and subPlanner work to delegate_task with its role; the server runs the judge on gated ledger items.",
        "",
        "## Now",
        BUILD_LEDGER_TEXT,
      ].join("\n"),
    );
  });

  it("leaves out what the thread does not have", () => {
    expect(resetSeedText({ ledger: undefined, loadout: null, buildText: "Build." })).toBe(
      [
        "This is a fresh session on an existing thread. The earlier conversation is not in your context; the user can still see it. What carries over is below.",
        "",
        "## Now",
        "Build.",
      ].join("\n"),
    );
  });
});

describe("buildMessageText", () => {
  it("implements the plan when there is one, else builds the ledger", () => {
    expect(buildMessageText(plan)).toBe("PLEASE IMPLEMENT THIS PLAN:\n# Ship it\n\n- step one");
    expect(buildMessageText(null)).toBe(BUILD_LEDGER_TEXT);
  });
});

describe("buildCommands", () => {
  const base = {
    threadId,
    key: "command:mcp:build-mode:k1",
    interactionMode: "plan" as const,
    plan,
    ledger,
    loadout,
    creationSource: "web" as const,
  };

  it("Build leaves plan mode and implements the plan in the same context", () => {
    const commands = buildCommands({ ...base, action: "build" });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.interaction-mode.set",
      "message.dispatch",
    ]);
    expect(commands[0]).toMatchObject({ interactionMode: "default" });
    expect(commands[1]).toMatchObject({
      text: buildMessageText(plan),
      sourcePlanRef: { threadId, planId: plan.id },
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    expect(commands[1]).not.toHaveProperty("freshProviderThread");
    expect(commands.every((command) => isReservedCommandId(command.commandId))).toBe(true);
  });

  it("Build outside plan mode does not touch the mode", () => {
    const commands = buildCommands({ ...base, interactionMode: "default", action: "build" });
    expect(commands.map((command) => command.type)).toEqual(["message.dispatch"]);
  });

  it("Compact and build compacts first and queues the build behind it", () => {
    const commands = buildCommands({ ...base, action: "compact_and_build" });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.interaction-mode.set",
      "message.dispatch",
      "message.dispatch",
    ]);
    expect(commands[1]).toMatchObject({
      text: "/compact",
      dispatchMode: { type: "start_immediately" },
    });
    expect(commands[1]).not.toHaveProperty("sourcePlanRef");
    expect(commands[2]).toMatchObject({
      text: buildMessageText(plan),
      sourcePlanRef: { threadId, planId: plan.id },
      dispatchMode: { type: "queue_after_active" },
    });
  });

  it("Reset and build starts a fresh provider thread seeded from the ledger", () => {
    const commands = buildCommands({ ...base, plan: null, action: "reset_and_build" });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.interaction-mode.set",
      "message.dispatch",
    ]);
    expect(commands[1]).toMatchObject({
      text: resetSeedText({ ledger, loadout, buildText: BUILD_LEDGER_TEXT }),
      freshProviderThread: true,
      dispatchMode: { type: "start_immediately" },
    });
  });

  it("gives every command and message its own id", () => {
    const commands = buildCommands({ ...base, action: "compact_and_build" });
    const ids = commands.map((command) => command.commandId);
    expect(new Set(ids).size).toBe(ids.length);
    const messageIds = commands.flatMap((command) =>
      command.type === "message.dispatch" ? [command.messageId] : [],
    );
    expect(new Set(messageIds).size).toBe(messageIds.length);
  });
});

describe("buildSubject", () => {
  const proposed = (id: string, status: "active" | "completed" | "superseded") => ({
    id: PlanId.make(id),
    threadId,
    runId: null,
    nodeId: NodeId.make(`node:${id}`),
    status,
    kind: "proposed_plan" as const,
    markdown: `# ${id}`,
  });
  const runs = (status: OrchestrationV2Run["status"]) => [{ status }];
  const subject = (input: Partial<Parameters<typeof buildSubject>[0]>) =>
    buildSubject({
      interactionMode: "plan",
      plans: [],
      ledger: undefined,
      runs: [],
      compactSupported: true,
      judgeConfigured: false,
      ...input,
    });

  it("builds the newest plan still waiting to be implemented", () => {
    expect(
      subject({
        plans: [proposed("p1", "active"), proposed("p2", "active"), proposed("p3", "completed")],
      }).plan?.id,
    ).toBe("p2");
    expect(subject({ plans: [proposed("p3", "completed")] }).plan).toBeNull();
  });

  it("counts an open ledger as work only while the thread is planning", () => {
    expect(subject({ ledger }).availability.build).toBeNull();
    expect(subject({ ledger, interactionMode: "default" }).availability.build).not.toBeNull();
    expect(subject({ ledger: { ...ledger, closedAt: at } }).availability.build).not.toBeNull();
  });

  it("refuses every action while a turn is running or queued", () => {
    for (const status of ["running", "queued", "starting"] as const) {
      expect(buildModeRefusal(subject({ ledger, runs: runs(status) }), "build")).toBe(
        "The thread is working. Wait for its turn to end, then build.",
      );
    }
    expect(buildModeRefusal(subject({ ledger, runs: runs("completed") }), "build")).toBeNull();
    expect(buildModeRefusal(subject({ ledger }), "audit")).toBe(
      "The thread's loadout has no judge role.",
    );
  });
});

describe("audit", () => {
  it("fences everything the planning agent wrote", () => {
    const prompt = auditPrompt({ requests: ["Port the parser"], plan, ledger });
    expect(prompt).toContain(FENCE_BEGIN);
    expect(prompt).toContain("# Ship it");
    expect(prompt).toContain("Generate parser");
    expect(prompt).toContain("FINDING:");
  });

  it("reads findings and ignores everything else", () => {
    expect(
      parseAuditFindings(
        [
          "Some reasoning first.",
          "FINDING: Plan skips the migration | A migration exists and runs in CI",
          "  finding:   No rollback step   |  ",
          "FINDING:    | acceptance with no title",
          "NO FINDINGS",
        ].join("\n"),
      ),
    ).toEqual([
      { title: "Plan skips the migration", acceptance: "A migration exists and runs in CI" },
      { title: "No rollback step", acceptance: "" },
    ]);
    expect(parseAuditFindings(null)).toEqual([]);
  });

  it("appends findings to an open ledger and starts one otherwise", () => {
    const findings = [{ title: "Plan skips the migration", acceptance: "A migration runs" }];
    const added = auditCommands({ threadId, key: "command:mcp:build-mode:k2", ledger, findings });
    expect(added).toMatchObject([
      {
        type: "ledger.item.add",
        ledgerId: ledger.id,
        items: [{ title: "Audit: Plan skips the migration", acceptance: "A migration runs" }],
      },
    ]);
    const created = auditCommands({
      threadId,
      key: "command:mcp:build-mode:k2",
      ledger: { ...ledger, closedAt: at },
      findings,
    });
    expect(created).toMatchObject([{ type: "ledger.create", title: "Plan audit" }]);
    expect(auditCommands({ threadId, key: "k", ledger, findings: [] })).toEqual([]);
  });
});
