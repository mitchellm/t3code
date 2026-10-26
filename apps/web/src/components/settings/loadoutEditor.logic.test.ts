import { LOADOUT_ROLE_NAMES, type Loadout, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  duplicateLoadout,
  effortFromSelections,
  effortOptionId,
  roleAfterModelChange,
  unassignedRoles,
  withRole,
} from "./loadoutEditor.logic";

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
  it("finds the effort option the model advertises, whatever the driver calls it", () => {
    expect(effortOptionId(model("a", ["low", "high"]))).toBe("effort");
    expect(effortOptionId(model("b", ["low"], "reasoningEffort"))).toBe("reasoningEffort");
    expect(effortOptionId({ slug: "c" })).toBeUndefined();
    expect(effortOptionId(undefined)).toBeUndefined();
  });

  it("reads the effort back out of a traits selection", () => {
    expect(effortFromSelections([{ id: "contextWindow", value: "1m" }])).toBeUndefined();
    expect(
      effortFromSelections([
        { id: "fastMode", value: true },
        { id: "effort", value: "high" },
      ]),
    ).toBe("high");
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
