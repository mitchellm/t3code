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
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  createLedgerRosterRecordsAtom,
  deriveLedgerAgentRoster,
  type LedgerRosterRecord,
} from "./ledgerRoster.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";

const at = (seconds: number) => DateTime.add(v2Now, { seconds });
const id = LedgerItemId.make;

const item = (name: string, extra: Partial<LedgerItem> = {}) =>
  ({
    id: id(name),
    title: `Item ${name}`,
    acceptance: "",
    status: "in_progress",
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

const link = (name: string) => ({
  taskId: NodeId.make(`task:${name}`),
  childThreadId: ThreadId.make(`thread:${name}`),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
  createdAt: v2Now,
});

const record = (
  name: string,
  status: OrchestrationV2Subagent["status"],
  extra: Partial<LedgerRosterRecord> = {},
): LedgerRosterRecord => ({
  id: NodeId.make(`task:${name}`),
  childThreadId: ThreadId.make(`thread:${name}`),
  origin: "app_owned",
  role: "worker",
  title: `Worker: ${name}`,
  model: "claude-sonnet-5-5",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  status,
  startedAt: v2Now,
  completedAt: null,
  ...extra,
});

describe("deriveLedgerAgentRoster", () => {
  it("links each agent to the items that name it, by tasks or as judge", () => {
    const ledger = ledgerOf([
      item("A", { tasks: [link("w1"), link("w2")] }),
      item("B", { tasks: [link("w1")], judgeTaskId: NodeId.make("task:j") }),
    ]);
    const roster = deriveLedgerAgentRoster(ledger, [
      record("w1", "running"),
      record("w2", "running"),
      record("j", "running", { role: undefined, serverJudge: true, title: "Judge B" }),
      record("loose", "running"),
    ]);
    const byId = new Map([...roster.active].map((row) => [row.taskId, row]));
    expect(byId.get("task:w1")?.itemIds).toEqual(["A", "B"]);
    expect(byId.get("task:w2")?.itemIds).toEqual(["A"]);
    expect(byId.get("task:j")?.itemIds).toEqual(["B"]);
    expect(byId.get("task:loose")?.itemIds).toEqual([]);
  });

  it("marks judges and provider-native subagents", () => {
    const roster = deriveLedgerAgentRoster(null, [
      record("server", "running", { role: undefined, serverJudge: true }),
      record("named", "running", { role: "judge" }),
      record("native", "running", { origin: "provider_native", role: undefined, title: null }),
      record("plain", "running"),
    ]);
    const byId = new Map(roster.active.map((row) => [row.taskId, row]));
    expect(byId.get("task:server")).toMatchObject({ judge: true, role: "judge", native: false });
    expect(byId.get("task:named")).toMatchObject({ judge: true, role: "judge" });
    expect(byId.get("task:native")).toMatchObject({
      judge: false,
      native: true,
      role: null,
      label: null,
    });
    expect(byId.get("task:plain")).toMatchObject({ judge: false, native: false, label: "plain" });
  });

  it("lists running agents by start and finished ones by most recent completion", () => {
    const roster = deriveLedgerAgentRoster(null, [
      record("late", "running", { startedAt: at(20) }),
      record("early", "waiting", { startedAt: at(5) }),
      record("pending", "pending", { startedAt: null }),
      record("old", "completed", { startedAt: at(0), completedAt: at(10) }),
      record("new", "failed", { startedAt: at(0), completedAt: at(30) }),
      record("stopped", "interrupted", { startedAt: at(0), completedAt: at(20) }),
    ]);
    expect(roster.active.map((row) => row.taskId)).toEqual([
      "task:early",
      "task:late",
      "task:pending",
    ]);
    expect(roster.finished.map((row) => row.taskId)).toEqual([
      "task:new",
      "task:stopped",
      "task:old",
    ]);
    expect(roster.counts).toEqual({ running: 3, done: 1, failed: 1, total: 6 });
  });

  it("words the status like the ledger agent lines, with the duration once done", () => {
    const roster = deriveLedgerAgentRoster(null, [
      record("busy", "running"),
      record("done", "completed", { startedAt: at(0), completedAt: at(72) }),
      record("bad", "failed", { startedAt: at(0), completedAt: at(72) }),
    ]);
    const byId = new Map([...roster.active, ...roster.finished].map((row) => [row.taskId, row]));
    expect(byId.get("task:busy")).toMatchObject({ tone: "running", statusLabel: "running" });
    expect(byId.get("task:done")).toMatchObject({ tone: "done", statusLabel: "done 1m 12s" });
    expect(byId.get("task:bad")).toMatchObject({ tone: "failed", statusLabel: "failed" });
  });
});

describe("createLedgerRosterRecordsAtom", () => {
  const subagent = (
    name: string,
    status: OrchestrationV2Subagent["status"],
    extra: Partial<OrchestrationV2Subagent> = {},
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
    ...extra,
  });
  const stateOf = (projection: OrchestrationV2ThreadProjection): EnvironmentThreadState => ({
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    data: Option.some(projection),
  });
  const subagentEvent = (payload: OrchestrationV2Subagent): OrchestrationV2DomainEvent =>
    ({
      id: EventId.make(`event:${payload.id}:${payload.status}:${payload.progress ?? ""}`),
      type: "subagent.updated",
      threadId: v2ThreadId,
      runId: payload.runId,
      occurredAt: at(1),
      payload,
    }) as OrchestrationV2DomainEvent;

  it("changes only when a field the roster reads does", () => {
    const projection: OrchestrationV2ThreadProjection = {
      ...v2Projection,
      subagents: [subagent("a", "running"), subagent("b", "running")],
    };
    const source = Atom.make(stateOf(projection));
    const records = createLedgerRosterRecordsAtom(source);
    const registry = AtomRegistry.make();
    const seen: Array<ReadonlyArray<LedgerRosterRecord>> = [];
    const unmount = registry.subscribe(records, (value) => seen.push(value), { immediate: true });
    expect(seen.at(-1)?.map((entry) => [entry.id, entry.status])).toEqual([
      ["task:a", "running"],
      ["task:b", "running"],
    ]);

    const progressed = applyOrchestrationV2ProjectionEvent(
      projection,
      subagentEvent(subagent("a", "running", { progress: "Reading files", prompt: "Changed" })),
    )!;
    registry.set(source, stateOf(progressed));
    expect(seen).toHaveLength(1);

    const done = applyOrchestrationV2ProjectionEvent(
      progressed,
      subagentEvent(subagent("a", "completed", { completedAt: at(5) })),
    )!;
    registry.set(source, stateOf(done));
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)?.map((entry) => entry.status)).toEqual(["completed", "running"]);
    unmount();
    registry.dispose();
  });

  it("is empty for a thread with no tasks", () => {
    const registry = AtomRegistry.make();
    const bare = createLedgerRosterRecordsAtom(Atom.make(stateOf(v2Projection)));
    const unmount = registry.mount(bare);
    expect(registry.get(bare)).toEqual([]);
    unmount();
    registry.dispose();
  });
});
