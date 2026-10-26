import { LOADOUT_ROLE_NAMES, type Loadout, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  duplicateLoadout,
  effortChoices,
  loadoutSettingsScopeSearch,
  missingPresets,
  newRoleDefault,
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
