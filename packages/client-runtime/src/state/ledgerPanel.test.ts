import {
  EventId,
  LedgerId,
  LedgerItemId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type Ledger,
  type LedgerItem,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type TaskStats,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  createLedgerTaskRecordsAtom,
  deriveLedgerAgentCard,
  deriveLedgerPanel,
  formatLedgerPanelCount,
  type LedgerAgentLine,
  type LedgerPanelRow,
  type LedgerTaskRecord,
} from "./ledgerPanel.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";

const at = (seconds: number) => DateTime.add(v2Now, { seconds });
const id = LedgerItemId.make;

const item = (name: string, status: LedgerItem["status"], extra: Partial<LedgerItem> = {}) =>
  ({
    id: id(name),
    title: `Item ${name}`,
    acceptance: "",
    status,
    evidence: null,
    dropReason: null,
    verdict: null,
    createdAt: v2Now,
    updatedAt: v2Now,
    closedAt: null,
    ...extra,
  }) satisfies LedgerItem;

const ledgerOf = (items: ReadonlyArray<LedgerItem>): Ledger => ({
  id: LedgerId.make("ledger"),
  threadId: v2ThreadId,
  title: "Ledger",
  startState: "",
  checkpoints: [],
  winConditions: [],
  items,
  createdAt: v2Now,
  updatedAt: v2Now,
  closedAt: null,
});

const link = (name: string, role?: string) => ({
  taskId: NodeId.make(`task:${name}`),
  childThreadId: ThreadId.make(`thread:${name}`),
  ...(role === undefined ? {} : { role }),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
  createdAt: v2Now,
});

const record = (
  name: string,
  status: OrchestrationV2Subagent["status"],
  options: { result?: string; startedAt?: number; completedAt?: number } = {},
): LedgerTaskRecord => ({
  id: NodeId.make(`task:${name}`),
  status,
  result: options.result ?? null,
  title: `Task ${name}`,
  startedAt: options.startedAt === undefined ? null : at(options.startedAt),
  completedAt: options.completedAt === undefined ? null : at(options.completedAt),
});

const verdict = (outcome: "pass" | "fail") => ({
  outcome,
  judge: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "judge" },
  notes: outcome === "pass" ? "Meets it." : "Evidence is missing.",
  at: v2Now,
});

const labels = (row: LedgerPanelRow | undefined) => row?.badges.map((badge) => badge.label);

describe("deriveLedgerPanel count", () => {
  it("counts done out of the items in scope, leaving dropped and deferred out", () => {
    const panel = deriveLedgerPanel(
      ledgerOf([
        item("A", "closed"),
        item("B", "closed"),
        item("C", "in_progress"),
        item("D", "open"),
        item("E", "dropped"),
        item("F", "deferred", { deferReason: "later" }),
      ]),
      [],
    );
    expect(panel.count).toMatchObject({ done: 2, total: 4, dropped: 1, deferred: 1 });
    expect(panel.count.fraction).toBe(0.5);
  });

  it("counts in-scope items added after the plan was written", () => {
    const panel = deriveLedgerPanel(
      ledgerOf([
        item("A", "closed"),
        item("B", "open", { createdAt: at(60) }),
        item("C", "in_progress", { createdAt: at(120) }),
        // Added later but set aside, so it is counted as deferred, not as scope growth.
        item("D", "deferred", { createdAt: at(180), deferReason: "later" }),
      ]),
      [],
    );
    expect(panel.count).toMatchObject({ done: 1, total: 3, addedSincePlan: 2, deferred: 1 });
    expect(formatLedgerPanelCount(panel.count)).toBe("done · 2 added since the plan · 1 deferred");
  });

  it("follows the ledger as items close, and has nothing to measure when empty", () => {
    const before = deriveLedgerPanel(ledgerOf([item("A", "open"), item("B", "open")]), []);
    const after = deriveLedgerPanel(ledgerOf([item("A", "closed"), item("B", "open")]), []);
    expect([before.count.done, after.count.done]).toEqual([0, 1]);
    const empty = deriveLedgerPanel(ledgerOf([]), []);
    expect(empty.count).toMatchObject({ done: 0, total: 0, fraction: 0 });
    expect(formatLedgerPanelCount(empty.count)).toBe("No items yet");
  });

  it("counts reached checkpoints", () => {
    const panel = deriveLedgerPanel(
      {
        ...ledgerOf([]),
        checkpoints: [
          { id: "cp1" as never, title: "One", reached: true, reachedAt: v2Now },
          { id: "cp2" as never, title: "Two", reached: false, reachedAt: null },
        ],
      },
      [],
    );
    expect(panel.checkpoints).toEqual({ reached: 1, total: 2 });
  });
});

describe("deriveLedgerPanel grouping", () => {
  it("keeps unfinished work in tree order and folds done and deferred items apart", () => {
    const panel = deriveLedgerPanel(
      ledgerOf([
        item("P", "in_progress"),
        item("Q", "open"),
        item("P1", "open", { parentItemId: id("P") }),
        item("P2", "closed", { parentItemId: id("P") }),
        item("R", "closed"),
        item("R1", "dropped", { parentItemId: id("R"), dropReason: "not needed" }),
        item("S", "deferred", { deferReason: "later" }),
        item("S1", "deferred", { parentItemId: id("S"), deferReason: "later" }),
        // Work in scope under a deferred or missing parent is lifted so it stays in view.
        item("S2", "open", { parentItemId: id("S") }),
        item("Z", "open", { parentItemId: id("missing") }),
      ]),
      [],
    );
    const shape = (rows: ReadonlyArray<LedgerPanelRow>) =>
      rows.map((row) => [row.item.id, row.depth]);
    expect(shape(panel.active)).toEqual([
      ["P", 0],
      ["P1", 1],
      ["Q", 0],
      ["S2", 0],
      ["Z", 0],
    ]);
    // A finished sub-item of unfinished work folds with the done items, at the top of that group.
    expect(shape(panel.done)).toEqual([
      ["P2", 0],
      ["R", 0],
      ["R1", 1],
    ]);
    expect(shape(panel.deferred)).toEqual([
      ["S", 0],
      ["S1", 1],
    ]);
  });
});

describe("deriveLedgerPanel badges", () => {
  const rowOf = (ledger: Ledger, name: string, records: ReadonlyArray<LedgerTaskRecord> = []) => {
    const panel = deriveLedgerPanel(ledger, records);
    return [...panel.active, ...panel.done, ...panel.deferred].find((row) => row.item.id === name);
  };

  it("shows judging over any earlier verdict, and a pass once judged", () => {
    const ledger = ledgerOf([
      item("J", "in_progress", { judging: true, verdict: verdict("fail"), judgements: 1 }),
      item("P", "closed", { verdict: verdict("pass"), judgements: 2, judgementsAtReopen: 2 }),
    ]);
    expect(labels(rowOf(ledger, "J"))).toEqual(["judging"]);
    expect(labels(rowOf(ledger, "P"))).toEqual(["passed"]);
  });

  it("counts failures since the item was last reopened", () => {
    const ledger = ledgerOf([
      item("F", "in_progress", { verdict: verdict("fail"), judgements: 3, judgementsAtReopen: 1 }),
      item("G", "open", { verdict: verdict("fail"), judgements: 1 }),
      // Reopened after its last failure: nothing has failed since.
      item("H", "open", { verdict: verdict("fail"), judgements: 2, judgementsAtReopen: 2 }),
      // An older record without the counter still says it failed.
      item("K", "open", { verdict: verdict("fail") }),
    ]);
    expect(labels(rowOf(ledger, "F"))).toEqual(["failed 2×"]);
    expect(labels(rowOf(ledger, "G"))).toEqual(["failed 1×"]);
    expect(labels(rowOf(ledger, "H"))).toEqual([]);
    expect(labels(rowOf(ledger, "K"))).toEqual(["failed"]);
  });

  it("names unfinished blockers only, on unfinished items", () => {
    const ledger = ledgerOf([
      item("A", "open"),
      item("B", "open"),
      item("C", "closed"),
      item("D", "open", { blockedBy: [id("A")] }),
      item("E", "open", { blockedBy: [id("A"), id("B"), id("C")] }),
      item("F", "open", { blockedBy: [id("C")] }),
    ]);
    expect(labels(rowOf(ledger, "D"))).toEqual(["after A"]);
    expect(labels(rowOf(ledger, "E"))).toEqual(["after A +1"]);
    expect(labels(rowOf(ledger, "F"))).toEqual([]);
    const blocked = rowOf(ledger, "E")?.badges.find((badge) => badge.kind === "blocked");
    expect(blocked?.kind === "blocked" ? blocked.blockedBy : null).toEqual(["A", "B"]);
  });

  it("counts linked agents and marks the count while one is working", () => {
    const ledger = ledgerOf([
      item("W", "in_progress", { tasks: [link("one", "explorer"), link("two", "worker")] }),
      item("X", "closed", { tasks: [link("three", "worker")] }),
    ]);
    const records = [
      record("one", "completed", { result: "Found it.", startedAt: 0, completedAt: 72 }),
      record("two", "running", { startedAt: 10 }),
      record("three", "completed", { result: "Done.", startedAt: 0, completedAt: 5 }),
    ];
    const working = rowOf(ledger, "W", records)?.badges.find((badge) => badge.kind === "agents");
    expect(working).toEqual({ kind: "agents", label: "2 agents", running: true });
    const finished = rowOf(ledger, "X", records)?.badges.find((badge) => badge.kind === "agents");
    expect(finished).toEqual({ kind: "agents", label: "1 agent", running: false });
  });
});

describe("deriveLedgerPanel agent lines", () => {
  const ledger = ledgerOf([
    item("W", "in_progress", {
      tasks: [link("explore", "explorer"), link("build", "worker"), link("broke"), link("gone")],
    }),
    item("X", "closed", { tasks: [link("old", "worker")] }),
    item("Y", "open"),
  ]);
  const records = [
    record("explore", "completed", {
      result: "Parser is in src/parse.ts.",
      startedAt: 0,
      completedAt: 72,
    }),
    record("build", "running", { startedAt: 30 }),
    record("broke", "failed", { result: "Could not build.", startedAt: 0, completedAt: 9 }),
    record("old", "completed", { result: "Done.", startedAt: 0, completedAt: 5 }),
  ];
  const panel = deriveLedgerPanel(ledger, records);
  const row = (name: string) =>
    [...panel.active, ...panel.done].find((entry) => entry.item.id === name);

  it("lists an unfinished item's agents inline and folds a finished item's to its count", () => {
    expect(row("W")?.agentsInline).toBe(true);
    expect(row("X")?.agentsInline).toBe(false);
    expect(row("X")?.agents).toHaveLength(1);
    expect(row("Y")?.agents).toEqual([]);
  });

  it("gives each line a status that never depends on the clock", () => {
    const lines = row("W")?.agents ?? [];
    expect(lines.map((line) => [line.task.role, line.tone, line.statusLabel])).toEqual([
      ["explorer", "done", "done 1m 12s"],
      ["worker", "running", "running"],
      [undefined, "failed", "failed"],
      // The link outlived its task record: still listed, with nothing live to show.
      [undefined, "unknown", "unknown"],
    ]);
    expect(lines[0]?.report).toBe("Parser is in src/parse.ts.");
    expect(lines[1]?.report).toBeNull();
  });
});

describe("deriveLedgerAgentCard", () => {
  const line = (
    status: OrchestrationV2Subagent["status"],
    startedAt: number | null,
    completedAt: number | null,
  ): LedgerAgentLine => {
    const panel = deriveLedgerPanel(
      ledgerOf([item("W", "in_progress", { tasks: [link("w", "worker")] })]),
      [
        record("w", status, {
          ...(startedAt === null ? {} : { startedAt }),
          ...(completedAt === null ? {} : { completedAt }),
        }),
      ],
    );
    return panel.active[0]!.agents[0]!;
  };
  const stats: TaskStats = {
    threadId: ThreadId.make("thread:w"),
    tokens: { input: 160_000, output: 22_000 },
    toolCalls: 41,
    activity: "PowerShell · label-zone.ps1 -Zone 47",
    branch: "agent/m4-zones-32-62",
    worktreePath: "C:/work/.t3/worktrees/m4",
  };
  const opened = DateTime.toEpochMillis(at(430));

  it("measures a running task up to when the card opened", () => {
    const card = deriveLedgerAgentCard(line("running", 30, null), stats, opened);
    expect(card.status).toBe("Running");
    expect(card.time).toEqual({
      label: "6m 40s",
      running: true,
      startedAtMs: DateTime.toEpochMillis(at(30)),
    });
    expect(card.activity).toBe("PowerShell · label-zone.ps1 -Zone 47");
  });

  it("gives a finished task its total time and no current activity", () => {
    const card = deriveLedgerAgentCard(line("completed", 0, 72), stats, opened);
    expect(card.status).toBe("Done");
    expect(card.time).toMatchObject({ label: "1m 12s", running: false });
    expect(card.activity).toBeNull();
  });

  it("totals tokens and tool calls and names the worktree's branch", () => {
    const card = deriveLedgerAgentCard(line("running", 30, null), stats, opened);
    expect(card.tokens).toBe("182K · 160K in, 22K out");
    expect(card.toolCalls).toBe(41);
    expect(card.workspace).toEqual({ label: "Worktree", value: "agent/m4-zones-32-62" });
    const sharedCheckout = deriveLedgerAgentCard(
      line("running", 30, null),
      { ...stats, worktreePath: null, branch: "main" },
      opened,
    );
    expect(sharedCheckout.workspace).toEqual({ label: "Branch", value: "main" });
  });

  it("shows what the client already knows while the stats load or when none were reported", () => {
    const loading = deriveLedgerAgentCard(line("running", 30, null), null, opened);
    expect(loading).toMatchObject({
      status: "Running",
      tokens: null,
      toolCalls: null,
      activity: null,
      workspace: null,
    });
    expect(loading.time?.label).toBe("6m 40s");
    const unreported = deriveLedgerAgentCard(
      line("completed", 0, 72),
      { ...stats, tokens: null, toolCalls: 0, branch: null, worktreePath: null },
      opened,
    );
    expect(unreported).toMatchObject({ tokens: null, toolCalls: 0, workspace: null });
    expect(deriveLedgerAgentCard(line("pending", null, null), null, opened).time).toBeNull();
  });
});

describe("createLedgerTaskRecordsAtom", () => {
  const subagent = (
    name: string,
    status: OrchestrationV2Subagent["status"],
  ): OrchestrationV2Subagent => ({
    id: NodeId.make(`task:${name}`),
    threadId: v2ThreadId,
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: "claudeAgent" as never,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerThreadId: null,
    childThreadId: ThreadId.make(`thread:${name}`),
    nativeTaskRef: null,
    prompt: "Do it",
    title: `Task ${name}`,
    model: "claude-sonnet-5-5",
    status,
    result: null,
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
  });
  const linkedLedger = ledgerOf([item("W", "in_progress", { tasks: [link("mine", "worker")] })]);
  const stateOf = (projection: OrchestrationV2ThreadProjection): EnvironmentThreadState => ({
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    data: Option.some(projection),
  });
  const subagentEvent = (payload: OrchestrationV2Subagent): OrchestrationV2DomainEvent =>
    ({
      id: EventId.make(`event:${payload.id}:${payload.status}`),
      type: "subagent.updated",
      threadId: v2ThreadId,
      runId: payload.runId,
      occurredAt: at(1),
      payload,
    }) as OrchestrationV2DomainEvent;

  it("changes only when a linked task does", () => {
    const projection: OrchestrationV2ThreadProjection = {
      ...v2Projection,
      ledger: linkedLedger,
      subagents: [subagent("mine", "running"), subagent("other", "running")],
    };
    const source = Atom.make(stateOf(projection));
    const tasks = createLedgerTaskRecordsAtom(source);
    const registry = AtomRegistry.make();
    const seen: Array<ReadonlyArray<LedgerTaskRecord>> = [];
    const unmount = registry.subscribe(tasks, (value) => seen.push(value), { immediate: true });
    expect(seen.at(-1)?.map((entry) => [entry.id, entry.status])).toEqual([
      ["task:mine", "running"],
    ]);

    // Another task's progress and a re-decoded copy of the linked record leave the value alone.
    const otherMoved = applyOrchestrationV2ProjectionEvent(
      projection,
      subagentEvent(subagent("other", "completed")),
    )!;
    registry.set(source, stateOf(otherMoved));
    const sameAgain = applyOrchestrationV2ProjectionEvent(
      otherMoved,
      subagentEvent(subagent("mine", "running")),
    )!;
    registry.set(source, stateOf(sameAgain));
    expect(seen).toHaveLength(1);

    const mineDone = applyOrchestrationV2ProjectionEvent(
      sameAgain,
      subagentEvent({ ...subagent("mine", "completed"), result: "Report", completedAt: at(5) }),
    )!;
    registry.set(source, stateOf(mineDone));
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)?.map((entry) => [entry.status, entry.result])).toEqual([
      ["completed", "Report"],
    ]);
    unmount();
    registry.dispose();
  });

  it("is empty for a thread with no ledger or no linked tasks", () => {
    const registry = AtomRegistry.make();
    const bare = createLedgerTaskRecordsAtom(Atom.make(stateOf(v2Projection)));
    const unmount = registry.mount(bare);
    expect(registry.get(bare)).toEqual([]);
    unmount();
    registry.dispose();
  });
});
