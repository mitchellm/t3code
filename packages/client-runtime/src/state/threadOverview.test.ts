import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadOverviewRows,
  ledgerBarFraction,
  type OverviewShellInput,
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

  it("matches judges by the server's `Judge ` title prefix and only on subagent children", () => {
    const rows = deriveThreadOverviewRows([
      shell("judged"),
      child("not-a-judge", "judged", { title: "Judging notes", runtime: runtime("running") }),
      shell("lookalike", { title: "Judge this later", runtime: runtime("idle") }),
    ]);
    expect(nowOf(rows, "judged")).toBe("idle");
    expect(nowOf(rows, "lookalike")).toBe("idle");
  });

  it("reads a settled plan-mode thread with a plan to review as waiting on you", () => {
    const planReady = {
      interactionMode: "plan" as const,
      hasActionableProposedPlan: true,
    };
    const rows = deriveThreadOverviewRows([
      shell("plan-ready", planReady),
      shell("plan-still-running", { ...planReady, runtime: runtime("running") }),
      shell("plan-mode-no-plan", { interactionMode: "plan" }),
    ]);
    expect(nowOf(rows, "plan-ready")).toBe("waiting");
    expect(nowOf(rows, "plan-still-running")).toBe("running");
    expect(nowOf(rows, "plan-mode-no-plan")).toBe("idle");
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

describe("ledger on the row", () => {
  it("comes from the shell summary, whatever the thread's age", () => {
    const rows = deriveThreadOverviewRows([
      shell("old", {
        updatedAt: "2020-01-01T00:00:00.000Z",
        ledgerProgress: { closed: 3, open: 4, total: 7 },
      }),
    ]);
    expect(rows[0]?.ledger).toEqual({ closed: 3, total: 7 });
  });

  it("is null for a thread with no ledger, a null summary or an older server's absent field", () => {
    const rows = deriveThreadOverviewRows([
      shell("none"),
      shell("null", { ledgerProgress: null }),
      shell("empty", { ledgerProgress: { closed: 0, open: 0, total: 0 } }),
    ]);
    expect(rows.map((row) => row.ledger)).toEqual([null, null, null]);
  });
});

describe("ledgerBarFraction", () => {
  it("counts dropped items out of the denominator and is zero without scope", () => {
    expect(ledgerBarFraction({ total: 7, closed: 5 })).toBeCloseTo(5 / 7);
    expect(ledgerBarFraction({ total: 0, closed: 0 })).toBe(0);
  });
});
