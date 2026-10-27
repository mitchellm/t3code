import {
  DEFAULT_LOADOUTS,
  LOADOUT_ROLE_NAMES,
  type Loadout,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  duplicateLoadout,
  effortChoices,
  loadoutSettingsScopeSearch,
  missingPresets,
  newRoleDefault,
  sameLoadout,
  sameRoles,
  roleAfterModelChange,
  unassignedRoles,
  withRole,
} from "./loadoutEditor.logic";

describe("effortChoices", () => {
  const withLabels = {
    slug: "m",
    capabilities: {
      optionDescriptors: [
        { id: "thinking", type: "boolean" },
        {
          id: "effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
        { id: "contextWindow", type: "select", options: [{ id: "1m", label: "1M" }] },
      ],
    },
  };

  it("lists only the effort options, never thinking, fast mode or context", () => {
    expect(effortChoices(withLabels)).toEqual([
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    expect(effortChoices({ slug: "x" })).toEqual([]);
    expect(effortChoices(undefined)).toEqual([]);
  });
});

describe("newRoleDefault", () => {
  const entry = (instanceId: string, enabled: boolean, slugs: ReadonlyArray<string>) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    enabled,
    isAvailable: true,
    models: slugs.map((slug) => ({ slug })),
  });

  it("picks the first usable instance's first model, and nothing without a catalog", () => {
    expect(newRoleDefault([entry("off", false, ["a"]), entry("on", true, ["b", "c"])])).toEqual({
      instanceId: "on",
      model: "b",
    });
    expect(newRoleDefault([])).toBeUndefined();
    expect(newRoleDefault([entry("empty", true, [])])).toBeUndefined();
  });
});

describe("cross-check preset", () => {
  const stored = DEFAULT_LOADOUTS.filter(({ id }) => id !== "cross-check");

  it("is offered automatically to a list saved before it existed", () => {
    expect(missingPresets(stored, DEFAULT_LOADOUTS, () => "fresh").map(({ id }) => id)).toEqual([
      "cross-check",
    ]);
    expect(missingPresets(DEFAULT_LOADOUTS, DEFAULT_LOADOUTS, () => "fresh")).toEqual([]);
  });

  it("counts a changed fallback as a different role", () => {
    const judge = DEFAULT_LOADOUTS.find(({ id }) => id === "cross-check")!.roles.judge!;
    const { fallback: _dropped, ...bare } = judge;
    expect(
      sameRoles({ ...loadout, roles: { judge } }, { ...loadout, roles: { judge: bare } }),
    ).toBe(false);
  });

  it("keeps the fallback when the judge's model is changed in the editor", () => {
    const judge = DEFAULT_LOADOUTS.find(({ id }) => id === "cross-check")!.roles.judge!;
    expect(
      roleAfterModelChange(judge, ProviderInstanceId.make("codex"), "gpt-6-astra", undefined)
        .fallback,
    ).toEqual(judge.fallback);
  });
});

describe("missingPresets", () => {
  const presets: ReadonlyArray<Loadout> = [
    { id: "solo", name: "Solo", description: "", roles: {} },
    { id: "blitz", name: "Blitz", description: "x", roles: { worker: loadout.roles.worker! } },
    { id: "napalm", name: "Napalm", description: "y", roles: { worker: loadout.roles.worker! } },
  ];

  it("offers only presets the list lacks, never Solo", () => {
    const have = [presets[0]!, presets[1]!];
    expect(missingPresets(have, presets, () => "fresh").map(({ id }) => id)).toEqual(["napalm"]);
  });

  it("keeps the preset id when unused and mints a new one when a different loadout holds it", () => {
    const squatter: Loadout = { id: "blitz", name: "Mine", description: "", roles: {} };
    const [copy] = missingPresets([presets[0]!, squatter], [presets[1]!], () => "fresh");
    expect(copy).toEqual({ ...presets[1], id: "fresh" });
    const [kept] = missingPresets([presets[0]!], [presets[1]!], () => "fresh");
    expect(kept?.id).toBe("blitz");
  });
});

describe("loadout equality", () => {
  const a: Loadout = {
    id: "x",
    name: "X",
    description: "d",
    roles: {
      planner: { instanceId: claude, model: "m", effort: "high" },
      worker: { model: "w", instanceId: claude },
    },
  };
  const reordered: Loadout = {
    description: "d",
    name: "X",
    roles: {
      worker: { instanceId: claude, model: "w" },
      planner: { effort: "high", model: "m", instanceId: claude },
    },
    id: "x",
  };

  it("ignores key order but sees any real difference", () => {
    expect(sameLoadout(a, reordered)).toBe(true);
    expect(sameRoles(a, reordered)).toBe(true);
    expect(sameLoadout(a, { ...a, description: "e" })).toBe(false);
    expect(sameRoles(a, withRole(a, "worker", undefined))).toBe(false);
    const { effort: _e, ...noEffort } = a.roles.planner!;
    expect(sameRoles(a, withRole(a, "planner", noEffort))).toBe(false);
  });

  it("treats a reordered preset as already held", () => {
    expect(missingPresets([reordered], [a], () => "fresh")).toEqual([]);
  });
});

describe("missingPresets naming", () => {
  const preset: Loadout = {
    id: "blitz",
    name: "Blitz",
    description: "",
    roles: { worker: loadout.roles.worker! },
  };

  it("names the copy '(updated)' when an older loadout holds the name, never duplicating a name", () => {
    const older: Loadout = { id: "old", name: "Blitz", description: "", roles: {} };
    const [copy] = missingPresets([older], [preset], () => "fresh");
    expect(copy?.name).toBe("Blitz (updated)");
    const taken: Loadout = { ...older, id: "old2", name: "Blitz (updated)" };
    const [again] = missingPresets([older, taken], [preset], () => "fresh");
    expect(again?.name).toBe("Blitz (updated 2)");
  });
});

describe("loadoutSettingsScopeSearch", () => {
  it("opens the project scope when the project overrides the list, else the machine", () => {
    expect(
      loadoutSettingsScopeSearch({
        environmentId: "env-1",
        projectOverridden: true,
        projectKey: "pk",
      }),
    ).toEqual({ project: "pk", machine: "env-1" });
    expect(
      loadoutSettingsScopeSearch({
        environmentId: "env-1",
        projectOverridden: false,
        projectKey: "pk",
      }),
    ).toEqual({ machine: "env-1" });
    expect(
      loadoutSettingsScopeSearch({
        environmentId: "env-1",
        projectOverridden: true,
        projectKey: null,
      }),
    ).toEqual({ machine: "env-1" });
  });
});

const claude = ProviderInstanceId.make("claudeAgent");

const loadout: Loadout = {
  id: "mine",
  name: "Mine",
  description: "d",
  roles: {
    planner: { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
    worker: { instanceId: claude, model: "claude-sonnet-5-5" },
  },
};

const model = (slug: string, efforts: ReadonlyArray<string>, optionId = "effort") => ({
  slug,
  capabilities: {
    optionDescriptors: [
      {
        id: optionId,
        type: "select",
        options: efforts.map((id) => ({ id })),
      },
    ],
  },
});

describe("withRole", () => {
  it("sets a role and removes one without touching the others", () => {
    const set = withRole(loadout, "judge", { instanceId: claude, model: "claude-opus-5-5" });
    expect(Object.keys(set.roles)).toEqual(["planner", "worker", "judge"]);
    const removed = withRole(set, "planner", undefined);
    expect(Object.keys(removed.roles)).toEqual(["worker", "judge"]);
    expect(loadout.roles.planner).toBeDefined();
  });
});

describe("unassignedRoles", () => {
  it("lists the roles still free to add, in role order", () => {
    expect(unassignedRoles(loadout)).toEqual(["subPlanner", "explorer", "judge"]);
    expect(unassignedRoles({ ...loadout, roles: {} })).toEqual([...LOADOUT_ROLE_NAMES]);
  });
});

describe("duplicateLoadout", () => {
  it("copies the roles under a new id and an unused name", () => {
    const copy = duplicateLoadout(loadout, [loadout], "mine-2");
    expect(copy).toEqual({ ...loadout, id: "mine-2", name: "Mine copy" });
    const again = duplicateLoadout(loadout, [loadout, copy], "mine-3");
    expect(again.name).toBe("Mine copy 2");
  });
});

describe("effort handling", () => {
  it("finds the effort options whatever the driver calls the option", () => {
    expect(effortChoices(model("b", ["low"], "reasoningEffort"))).toEqual([
      { id: "low", label: "low" },
    ]);
  });
});

describe("roleAfterModelChange", () => {
  const planner = loadout.roles.planner;

  it("keeps the effort when the new model offers it", () => {
    expect(
      roleAfterModelChange(planner, claude, "claude-opus-5-5-b", model("x", ["high", "xhigh"])),
    ).toEqual({ instanceId: claude, model: "claude-opus-5-5-b", effort: "xhigh" });
  });

  it("drops an effort the new model does not offer instead of saving a dead value", () => {
    expect(
      roleAfterModelChange(planner, claude, "claude-haiku-5-5", model("x", ["low", "high"])),
    ).toEqual({ instanceId: claude, model: "claude-haiku-5-5" });
    expect(roleAfterModelChange(planner, claude, "claude-haiku-5-5", undefined)).toEqual({
      instanceId: claude,
      model: "claude-haiku-5-5",
    });
  });
});
