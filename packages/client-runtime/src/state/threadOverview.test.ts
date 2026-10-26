import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadOverviewRows,
  ledgerBarFraction,
  shouldLoadOverviewLedger,
  type OverviewShellInput,
  type ThreadOverviewRow,
} from "./threadOverview.ts";

const environmentId = EnvironmentId.make("environment-1");

function runtime(status: "running" | "idle" | "waiting") {
  return {
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function shell(id: string, overrides: Partial<OverviewShellInput> = {}): OverviewShellInput {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: "project-1" as OverviewShellInput["projectId"],
    title: id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    deletedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
    loadout: null,
    itemCount: 0,
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const child = (id: string, parent: string, overrides: Partial<OverviewShellInput> = {}) =>
  shell(id, {
    lineage: {
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make(parent),
    },
    ...overrides,
  });

const nowOf = (rows: ReturnType<typeof deriveThreadOverviewRows>, id: string) =>
  rows.find((row) => row.threadId === id)?.now;

describe("deriveThreadOverviewRows", () => {
  it("lists only active top-level threads, leaving out archived, deleted, subagent and retro rows", () => {
    const rows = deriveThreadOverviewRows([
      shell("live"),
      shell("archived", { archivedAt: "2026-06-01T00:00:00.000Z" }),
      shell("deleted", { deletedAt: "2026-06-01T00:00:00.000Z" }),
      child("sub", "live"),
      shell("thread:retro:live"),
    ]);
    expect(rows.map((row) => row.threadId)).toEqual(["live"]);
  });

  it("reads pending approvals, user input and a child's request as waiting on you, over running", () => {
    const rows = deriveThreadOverviewRows([
      shell("approval", { hasPendingApprovals: true, runtime: runtime("running") }),
      shell("input", { hasPendingUserInput: true }),
      shell("child-asks", { pendingSubagentRequest: "approval" }),
    ]);
    expect(rows.map((row) => row.now)).toEqual(["waiting", "waiting", "waiting"]);
  });

  it("reads a live Judge child as judging and a non-judge child as the parent running", () => {
    const rows = deriveThreadOverviewRows([
      shell("judged"),
      child("judge", "judged", { title: "Judge item-1: ship it", runtime: runtime("running") }),
      shell("helped", { runtime: runtime("running") }),
      child("helper", "helped", { title: "Explore", runtime: runtime("running") }),
    ]);
    expect(nowOf(rows, "judged")).toBe("judging");
    expect(nowOf(rows, "helped")).toBe("running");
  });

  it("does not read a finished judge as judging", () => {
    const rows = deriveThreadOverviewRows([
      shell("judged"),
      child("judge", "judged", { title: "Judge item-1: ship it", runtime: runtime("idle") }),
    ]);
    expect(nowOf(rows, "judged")).toBe("idle");
  });

  it("orders waiting, judging, running, then idle, newest first within a group", () => {
    const rows = deriveThreadOverviewRows([
      shell("idle-new", { updatedAt: "2026-06-03T00:00:00.000Z" }),
      shell("run-old", { runtime: runtime("running"), updatedAt: "2026-06-01T00:00:00.000Z" }),
      shell("run-new", { runtime: runtime("running"), updatedAt: "2026-06-02T00:00:00.000Z" }),
      shell("wait", { hasPendingUserInput: true }),
    ]);
    expect(rows.map((row) => row.threadId)).toEqual(["wait", "run-new", "run-old", "idle-new"]);
  });

  it("carries the loadout id, solo when none is set", () => {
    const rows = deriveThreadOverviewRows([
      shell("a", { loadout: { id: "org", reason: null, setBy: "user" } }),
      shell("b"),
    ]);
    expect(rows.map((row) => row.loadoutId)).toEqual(["org", null]);
  });
});

describe("shouldLoadOverviewLedger", () => {
  const nowMs = Date.parse("2026-06-10T00:00:00.000Z");
  const row = (now: ThreadOverviewRow["now"], updatedAt: string) => ({ now, updatedAt });

  it("loads for anything not idle and for idle threads touched within a day", () => {
    expect(shouldLoadOverviewLedger(row("running", "2026-01-01T00:00:00.000Z"), nowMs)).toBe(true);
    expect(shouldLoadOverviewLedger(row("idle", "2026-06-09T12:00:00.000Z"), nowMs)).toBe(true);
  });

  it("skips old idle threads so the page does not open a detail stream for each", () => {
    expect(shouldLoadOverviewLedger(row("idle", "2026-06-08T00:00:00.000Z"), nowMs)).toBe(false);
    expect(shouldLoadOverviewLedger(row("idle", "not a date"), nowMs)).toBe(false);
  });
});

describe("ledgerBarFraction", () => {
  it("counts dropped items out of the denominator and is zero without scope", () => {
    expect(ledgerBarFraction({ total: 8, closed: 5, dropped: 1 })).toBeCloseTo(5 / 7);
    expect(ledgerBarFraction({ total: 2, closed: 0, dropped: 2 })).toBe(0);
    expect(ledgerBarFraction({ total: 0, closed: 0, dropped: 0 })).toBe(0);
  });
});
