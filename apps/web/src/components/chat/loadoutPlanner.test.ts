import {
  type Loadout,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadLoadout,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeModelDisabledReason } from "../ChatView.logic";
import {
  type PlannerLock,
  type PlannerProviderView,
  plannerModelSwitch,
  withOptionOverrides,
} from "./loadoutPlanner";

const superbot = ProviderInstanceId.make("superbot");
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

const withEffort = (slug: string) => ({
  slug,
  capabilities: {
    optionDescriptors: [
      { id: "effort", type: "select", options: [{ id: "low" }, { id: "high" }, { id: "xhigh" }] },
    ],
  },
});

const providers: ReadonlyArray<PlannerProviderView> = [
  {
    instanceId: superbot,
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: "superbot-account" },
    models: [withEffort("superbot")],
  },
  {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [withEffort("claude-opus-5-5"), withEffort("claude-haiku-5-5")],
  },
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    models: [{ slug: "gpt-6.1-sol" }],
  },
];

// The loadout Mitchell picked when the thread kept running on the composer's model.
const oversight: Loadout = {
  id: "abliterated-oversight",
  name: "Abliterated Oversight",
  description: "",
  roles: {
    planner: { instanceId: superbot, model: "superbot", effort: "high" },
    explorer: { instanceId: claude, model: "claude-haiku-5-5" },
    worker: { instanceId: claude, model: "claude-sonnet-5-5" },
    judge: { instanceId: claude, model: "claude-opus-5-5", effort: "high" },
  },
};

const picked = (loadout: Loadout): ThreadLoadout => ({
  id: loadout.id,
  reason: null,
  setBy: "user",
});

const unlocked: PlannerLock = {
  lockedProvider: null,
  lockedContinuationGroupKey: null,
  modelDisabledReason: () => null,
};

describe("plannerModelSwitch", () => {
  it("moves the composer onto the planner's instance, model and effort", () => {
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        providers,
        lock: unlocked,
      }),
    ).toEqual({
      _tag: "switch",
      selection: {
        instanceId: superbot,
        model: "superbot",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  it("runs the planner's fallback when its own instance is gone", () => {
    const loadout: Loadout = {
      ...oversight,
      roles: {
        planner: {
          instanceId: ProviderInstanceId.make("removed"),
          model: "superbot",
          fallback: { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
        },
      },
    };
    expect(
      plannerModelSwitch({ pick: picked(loadout), loadout, providers, lock: unlocked }),
    ).toEqual({
      _tag: "switch",
      selection: {
        instanceId: claude,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      },
    });
  });

  it("leaves the model alone on Clear, an agent proposal, and a loadout with no planner", () => {
    const workersOnly: Loadout = { ...oversight, roles: { worker: oversight.roles.worker! } };
    const none = { _tag: "none" };
    expect(
      plannerModelSwitch({ pick: null, loadout: oversight, providers, lock: unlocked }),
    ).toEqual(none);
    expect(
      plannerModelSwitch({
        pick: { id: oversight.id, reason: "big task", setBy: "agent" },
        loadout: oversight,
        providers,
        lock: unlocked,
      }),
    ).toEqual(none);
    expect(
      plannerModelSwitch({
        pick: picked(workersOnly),
        loadout: workersOnly,
        providers,
        lock: unlocked,
      }),
    ).toEqual(none);
  });

  it("keeps a thread locked to another provider on its model, and says so", () => {
    const result = plannerModelSwitch({
      pick: picked(oversight),
      loadout: oversight,
      providers,
      lock: { ...unlocked, lockedProvider: ProviderDriverKind.make("codex") },
    });
    expect(result).toEqual({
      _tag: "kept",
      reason:
        "This thread is locked to its provider, so it stays on its current model. Start a new chat to plan on superbot.",
    });
  });

  it("keeps a thread on another account of the same driver on its model", () => {
    const result = plannerModelSwitch({
      pick: picked(oversight),
      loadout: oversight,
      providers,
      lock: {
        ...unlocked,
        lockedProvider: ProviderDriverKind.make("claudeAgent"),
        lockedContinuationGroupKey: "other-account",
      },
    });
    expect(result._tag).toBe("kept");
  });

  it("repeats the model picker's own reason when a started thread cannot change models", () => {
    const modelDisabledReason = makeModelDisabledReason({
      providers: [{ instanceId: superbot, requiresNewThreadForModelChange: true }],
      hasStartedSession: true,
      currentModelSelection: { instanceId: superbot, model: "superbot-mini" },
      currentProviderInstanceId: superbot,
    });
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        providers,
        lock: { ...unlocked, modelDisabledReason },
      }),
    ).toEqual({
      _tag: "kept",
      reason:
        "This thread stays on its current model. This provider does not allow switching models after a conversation has started. Start a new thread to use this model.",
    });
  });

  it("says the planner is unavailable when neither it nor its fallback resolves", () => {
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        providers: providers.filter(({ instanceId }) => instanceId !== superbot),
        lock: unlocked,
      }),
    ).toEqual({
      _tag: "kept",
      reason:
        "The planner, superbot, is not available here, so this thread stays on its current model.",
    });
  });

  it("waits for the provider list rather than calling the planner unavailable", () => {
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        providers: [],
        lock: unlocked,
      }),
    ).toEqual({ _tag: "none" });
  });
});

describe("withOptionOverrides", () => {
  it("puts the planner's effort over the model's remembered options and keeps the rest", () => {
    const remembered = [
      { id: "effort", value: "low" },
      { id: "fastMode", value: true },
    ];
    expect(withOptionOverrides(remembered, [{ id: "effort", value: "high" }])).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    expect(withOptionOverrides(undefined, [{ id: "effort", value: "high" }])).toEqual([
      { id: "effort", value: "high" },
    ]);
    expect(withOptionOverrides(remembered, undefined)).toBe(remembered);
  });
});
