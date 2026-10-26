import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_LOADOUTS, type Loadout, ProviderInstanceId } from "@t3tools/contracts";

import { loadoutDelegationTarget, resolveLoadout } from "./loadouts.ts";
import { loadoutRoleIssues, summarizeLoadoutRoles } from "./loadoutSummary.ts";

const claude = ProviderInstanceId.make("claudeAgent");

const provider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
  enabled = true,
) => ({
  instanceId,
  enabled,
  models: models.map((slug) => ({ slug })),
});

describe("summarizeLoadoutRoles", () => {
  const summary = (id: string) => summarizeLoadoutRoles(resolveLoadout(DEFAULT_LOADOUTS, id));

  it("says who plans, works and judges in role order, with effort where one is set", () => {
    expect(summary("planner-workers-judge")).toBe(
      "Opus xhigh plans · Sonnet works · Opus high judges",
    );
    expect(summary("opus-blowout")).toBe("Opus xhigh plans · Opus high works · Opus high judges");
    expect(summary("blitz")).toBe(
      "Opus high plans · Haiku explores · Sonnet works · Sonnet judges",
    );
    expect(summary("napalm")).toBe("Sonnet plans · Haiku explores · Sonnet works · Haiku judges");
    expect(summary("haiku-workers")).toBe(
      "Opus xhigh plans · Haiku xhigh works · Opus high judges",
    );
    expect(summary("read-only-sweep")).toBe("Haiku explores");
  });

  it("describes solo as having no delegated roles", () => {
    expect(summary("solo")).toBe("No delegated roles");
  });

  it("falls back to the raw model slug when it is not a Claude family name", () => {
    const loadout: Loadout = {
      id: "mine",
      name: "Mine",
      description: "",
      roles: { subPlanner: { instanceId: claude, model: "gpt-5.5", effort: "high" } },
    };
    expect(summarizeLoadoutRoles(loadout)).toBe("gpt-5.5 high sub-plans");
  });
});

describe("loadoutRoleIssues", () => {
  it("reports nothing when every role resolves", () => {
    const catalog = [
      provider(claude, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]),
    ];
    for (const loadout of DEFAULT_LOADOUTS) {
      expect(loadoutRoleIssues(loadout, catalog)).toEqual([]);
    }
  });

  it("flags every preset role when the catalog lacks the instance, and delegation degrades", () => {
    const blitz = resolveLoadout(DEFAULT_LOADOUTS, "blitz");
    expect(loadoutRoleIssues(blitz, [])).toEqual([
      { role: "planner", issue: "missing_instance" },
      { role: "explorer", issue: "missing_instance" },
      { role: "worker", issue: "missing_instance" },
      { role: "judge", issue: "missing_instance" },
    ]);
    for (const loadout of DEFAULT_LOADOUTS) {
      for (const name of Object.keys(loadout.roles)) {
        expect(loadoutDelegationTarget(loadout, name, [])).toBeUndefined();
      }
    }
  });

  it("flags a disabled instance and a model the instance does not offer", () => {
    const napalm = resolveLoadout(DEFAULT_LOADOUTS, "napalm");
    expect(
      loadoutRoleIssues(napalm, [provider(claude, ["claude-sonnet-5-5"], false)]).map(
        ({ issue }) => issue,
      ),
    ).toEqual(["disabled_instance", "disabled_instance", "disabled_instance", "disabled_instance"]);
    expect(loadoutRoleIssues(napalm, [provider(claude, ["claude-sonnet-5-5"])])).toEqual([
      { role: "explorer", issue: "missing_model" },
      { role: "judge", issue: "missing_model" },
    ]);
  });
});
