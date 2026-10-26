import { describe, expect, it } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { acceptanceCriteria, workspaceCheckpoints } from "./LedgerJudgeCriteria.ts";

describe("acceptanceCriteria", () => {
  it("does not split after common abbreviations", () => {
    expect(
      acceptanceCriteria(
        "Handles flags, e.g. --force and -v. Works in the U.S. Region names, i.e. us-east, etc. Still hold.",
      ),
    ).toEqual([
      "Handles flags, e.g. --force and -v.",
      "Works in the U.S. Region names, i.e. us-east, etc. Still hold.",
    ]);
  });

  it("drops lines that are only code fences or heading markers", () => {
    expect(acceptanceCriteria("```ts\n`vp test run` passes\n```\n##\n~~~\nExit code is 0")).toEqual(
      ["`vp test run` passes", "Exit code is 0"],
    );
  });
});

describe("workspaceCheckpoints", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const scope = (id: string, cwd: string, kind: "root_run" | "tool", createdAt: string) => ({
    id: CheckpointScopeId.make(id),
    cwd,
    kind,
    createdAt: at(createdAt),
  });
  const checkpoint = (scopeId: string, ref: string) => ({
    scopeId: CheckpointScopeId.make(scopeId),
    ref: CheckpointRef.make(ref),
    status: "ready" as const,
    capturedAt: at("2026-01-01T00:00:00.000Z"),
  });

  it("keeps only checkpoints taken in the thread's current run workspace", () => {
    const kept = workspaceCheckpoints(
      [
        checkpoint("scope:old", "refs/old"),
        checkpoint("scope:tool", "refs/tool"),
        checkpoint("scope:now", "refs/now"),
        checkpoint("scope:again", "refs/again"),
      ],
      [
        scope("scope:old", "C:/repo", "root_run", "2026-01-01T00:00:00.000Z"),
        scope("scope:tool", "C:/elsewhere", "tool", "2026-01-01T03:00:00.000Z"),
        scope("scope:now", "C:/repo/.t3/worktrees/w", "root_run", "2026-01-01T02:00:00.000Z"),
        scope("scope:again", "C:/repo/.t3/worktrees/w", "root_run", "2026-01-01T01:00:00.000Z"),
      ],
    );
    expect(kept.map(({ ref }) => ref)).toEqual(["refs/now", "refs/again"]);
  });

  it("keeps everything when the thread has no run scope to say where it works", () => {
    expect(workspaceCheckpoints([checkpoint("scope:x", "refs/x")], [])).toHaveLength(1);
  });
});
