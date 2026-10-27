import {
  type Loadout,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadLoadout,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { makeModelDisabledReason } from "../ChatView.logic";
import {
  applyPlannerModelSwitch,
  type PlannerPicker,
  plannerModelSwitch,
  plannerNotRunning,
  type SelectModel,
  withOptionOverrides,
} from "./loadoutPlanner";

const superbot = ProviderInstanceId.make("superbot");
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");
const projectId = ProjectId.make("project-a");

function snapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string;
  readonly groupKey?: string;
  readonly models: ReadonlyArray<string>;
  readonly effortId: "effort" | "reasoningEffort";
  readonly status?: ServerProvider["status"];
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.groupKey === undefined ? {} : { continuation: { groupKey: input.groupKey } }),
    enabled: true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: input.status === "error" ? "unauthenticated" : "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: input.effortId,
            label: "Effort",
            type: "select",
            options: ["low", "high", "xhigh"].map((level) => ({ id: level, label: level })),
          },
        ],
      },
    })),
    slashCommands: [],
    skills: [],
  };
}

const superbotSnapshot = snapshot({
  instanceId: superbot,
  driver: claudeDriver,
  displayName: "Superbot",
  groupKey: "superbot-account",
  models: ["superbot", "superbot-mini"],
  effortId: "effort",
});
const providers: ReadonlyArray<ServerProvider> = [
  superbotSnapshot,
  snapshot({
    instanceId: claude,
    driver: claudeDriver,
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    effortId: "effort",
  }),
  snapshot({
    instanceId: codex,
    driver: codexDriver,
    models: ["gpt-6.1-sol"],
    effortId: "reasoningEffort",
  }),
];

const settings: UnifiedSettings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    [superbot]: { driver: claudeDriver, enabled: true },
    [claude]: { driver: claudeDriver, enabled: true },
    [codex]: { driver: codexDriver, enabled: true },
  },
};

/** Entries and options exactly as the composer builds them for its model picker. */
function picker(input?: {
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly settings?: UnifiedSettings;
  readonly projectId?: ProjectId;
  readonly lock?: Partial<
    Pick<PlannerPicker, "lockedProvider" | "lockedContinuationGroupKey" | "modelDisabledReason">
  >;
}): PlannerPicker {
  const resolved = input?.settings ?? settings;
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(input?.providers ?? providers),
    resolved,
    input?.projectId ?? null,
  );
  return {
    entries,
    modelOptionsByInstance: new Map(
      entries.map((entry) => [
        entry.instanceId,
        getAppModelOptionsForInstance(resolved, entry, null),
      ]),
    ),
    lockedProvider: null,
    lockedContinuationGroupKey: null,
    modelDisabledReason: () => null,
    ...input?.lock,
  };
}

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

const withPlanner = (planner: NonNullable<Loadout["roles"]["planner"]>): Loadout => ({
  ...oversight,
  roles: { ...oversight.roles, planner },
});

describe("plannerModelSwitch", () => {
  it("moves the composer onto the planner's instance, model and effort", () => {
    expect(
      plannerModelSwitch({ pick: picked(oversight), loadout: oversight, picker: picker() }),
    ).toEqual({
      _tag: "switch",
      selection: {
        instanceId: superbot,
        model: "superbot",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  it("maps a Codex planner's effort onto reasoningEffort", () => {
    const loadout = withPlanner({ instanceId: codex, model: "gpt-6.1-sol", effort: "xhigh" });
    expect(plannerModelSwitch({ pick: picked(loadout), loadout, picker: picker() })).toEqual({
      _tag: "switch",
      selection: {
        instanceId: codex,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    });
  });

  it("runs the planner's fallback when its own instance is gone", () => {
    const loadout = withPlanner({
      instanceId: ProviderInstanceId.make("removed"),
      model: "superbot",
      fallback: { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
    });
    expect(plannerModelSwitch({ pick: picked(loadout), loadout, picker: picker() })).toEqual({
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
    expect(plannerModelSwitch({ pick: null, loadout: oversight, picker: picker() })).toEqual(none);
    expect(
      plannerModelSwitch({
        pick: { id: oversight.id, reason: "big task", setBy: "agent" },
        loadout: oversight,
        picker: picker(),
      }),
    ).toEqual(none);
    expect(
      plannerModelSwitch({ pick: picked(workersOnly), loadout: workersOnly, picker: picker() }),
    ).toEqual(none);
  });

  it("waits for the provider list rather than calling the planner unavailable", () => {
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ providers: [] }),
      }),
    ).toEqual({ _tag: "none" });
  });

  it("keeps a thread locked to another provider, in the model picker's own words", () => {
    const kept = {
      _tag: "kept",
      reason: "Superbot is unavailable in this thread. Start a new thread to switch providers.",
    };
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ lock: { lockedProvider: codexDriver } }),
      }),
    ).toEqual(kept);
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({
          lock: { lockedProvider: claudeDriver, lockedContinuationGroupKey: "other-account" },
        }),
      }),
    ).toEqual(kept);
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
        picker: picker({ lock: { modelDisabledReason } }),
      }),
    ).toEqual({
      _tag: "kept",
      reason:
        "This provider does not allow switching models after a conversation has started. Start a new thread to use this model.",
    });
  });

  it("keeps the model when the planner's model is hidden in the model picker", () => {
    const hidden: UnifiedSettings = {
      ...settings,
      providerModelPreferences: { [superbot]: { hiddenModels: ["superbot"], modelOrder: [] } },
    };
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ settings: hidden }),
      }),
    ).toEqual({
      _tag: "kept",
      reason:
        "Superbot does not offer superbot in the model picker. This thread stays on its current model.",
    });
  });

  it("keeps the model when the provider lists no models, unless a custom model matches", () => {
    const unlisted = [{ ...superbotSnapshot, models: [] }, ...providers.slice(1)];
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ providers: unlisted }),
      })._tag,
    ).toBe("kept");
    const custom: UnifiedSettings = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        [superbot]: { driver: claudeDriver, enabled: true, config: { customModels: ["superbot"] } },
      },
    };
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ providers: unlisted, settings: custom }),
      }),
    ).toEqual({ _tag: "switch", selection: { instanceId: superbot, model: "superbot" } });
  });

  it("keeps the model when the planner's instance is disabled for this project only", () => {
    const projectOff: UnifiedSettings = {
      ...settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [superbot]: { enabled: false } } },
      },
    };
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ settings: projectOff, projectId }),
      }),
    ).toEqual({
      _tag: "kept",
      reason: "Superbot is not available here. This thread stays on its current model.",
    });
    const withFallback = withPlanner({
      ...oversight.roles.planner!,
      fallback: { instanceId: claude, model: "claude-opus-5-5" },
    });
    expect(
      plannerModelSwitch({
        pick: picked(withFallback),
        loadout: withFallback,
        picker: picker({ settings: projectOff, projectId }),
      }),
    ).toEqual({ _tag: "switch", selection: { instanceId: claude, model: "claude-opus-5-5" } });
  });

  it("keeps the model when the planner's provider is signed out or erroring", () => {
    const signedOut = [{ ...superbotSnapshot, status: "error" as const }, ...providers.slice(1)];
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ providers: signedOut }),
      }),
    ).toEqual({
      _tag: "kept",
      reason: "Superbot is not available here. This thread stays on its current model.",
    });
  });
});

describe("plannerNotRunning", () => {
  it("is quiet while the composer is on the planner", () => {
    expect(
      plannerNotRunning({
        loadout: oversight,
        picker: picker(),
        actual: { instanceId: superbot, model: "superbot" },
      }),
    ).toBeNull();
  });

  it("says so once the model was changed by hand, or the loadout came without a switch", () => {
    expect(
      plannerNotRunning({
        loadout: oversight,
        picker: picker(),
        actual: { instanceId: claude, model: "claude-opus-5-5" },
      }),
    ).toBe(
      "This thread runs on claude-opus-5-5, not its planner, superbot. Pick the loadout again to switch.",
    );
  });

  it("gives the reason when the planner cannot run on this thread", () => {
    expect(
      plannerNotRunning({
        loadout: oversight,
        picker: picker({ lock: { lockedProvider: codexDriver } }),
        actual: { instanceId: codex, model: "gpt-6.1-sol" },
      }),
    ).toBe("Superbot is unavailable in this thread. Start a new thread to switch providers.");
  });

  it("is quiet for a loadout without a planner and before the catalog loads", () => {
    const workersOnly: Loadout = { ...oversight, roles: { worker: oversight.roles.worker! } };
    const actual = { instanceId: claude, model: "claude-opus-5-5" };
    expect(plannerNotRunning({ loadout: workersOnly, picker: picker(), actual })).toBeNull();
    expect(
      plannerNotRunning({ loadout: oversight, picker: picker({ providers: [] }), actual }),
    ).toBeNull();
  });
});

describe("applyPlannerModelSwitch", () => {
  const planner = {
    _tag: "switch",
    selection: {
      instanceId: superbot,
      model: "superbot",
      options: [{ id: "effort", value: "high" }],
    },
  } as const;

  it("moves through the model picker's path with the planner's effort, and is quiet once there", () => {
    const calls: Array<Parameters<SelectModel>> = [];
    const select: SelectModel = (...args) => {
      calls.push(args);
      return { instanceId: args[0], model: args[1], options: [{ id: "effort", value: "high" }] };
    };
    expect(applyPlannerModelSwitch(planner, select)).toBeNull();
    expect(calls).toEqual([
      [
        superbot,
        "superbot",
        { focusComposer: false, optionOverrides: [{ id: "effort", value: "high" }] },
      ],
    ]);
  });

  it("reports a switch the model picker refused or landed elsewhere", () => {
    expect(applyPlannerModelSwitch(planner, () => null)).toBe(
      "The model picker did not switch to superbot. This thread stays on its current model.",
    );
    expect(
      applyPlannerModelSwitch(planner, () => ({ instanceId: superbot, model: "superbot-mini" })),
    ).toBe("The model picker chose superbot-mini instead of the planner, superbot.");
  });

  it("passes a kept reason through without touching the model, and stays quiet for none", () => {
    const select: SelectModel = () => {
      throw new Error("the model must not move");
    };
    expect(applyPlannerModelSwitch({ _tag: "kept", reason: "Locked." }, select)).toBe("Locked.");
    expect(applyPlannerModelSwitch({ _tag: "none" }, select)).toBeNull();
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
