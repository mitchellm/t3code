import {
  type Loadout,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadLoadout,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { summarizeLoadoutRoles } from "@t3tools/shared/loadoutSummary";
import { describe, expect, it } from "vite-plus/test";

import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { makeModelDisabledReason } from "../ChatView.logic";
import {
  applyPlannerModelSwitch,
  loadoutAsRun,
  type PlannerPicker,
  plannerModelSwitch,
  plannerRun,
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
  /** What the composer holds; by default one model that is no planner's. */
  readonly composer?: Partial<Pick<PlannerPicker, "disabled" | "selected" | "fanOut">>;
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
    disabled: false,
    selected: { instanceId: claude, model: "claude-sonnet-5-5" },
    fanOut: null,
    ...input?.lock,
    ...input?.composer,
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

  it("keeps the model before the provider list loads, and says so rather than calling it gone", () => {
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ providers: [] }),
      }),
    ).toEqual({
      _tag: "kept",
      reason:
        "Model picker has not loaded its models yet, so this thread stays on its current model. Pick the loadout again once it has.",
    });
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

  it("falls to the fallback when the thread's lock refuses the planner itself", () => {
    const loadout = withPlanner({
      instanceId: codex,
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
    });
    expect(
      plannerModelSwitch({
        pick: picked(loadout),
        loadout,
        picker: picker({ lock: { lockedProvider: claudeDriver } }),
      }),
    ).toEqual({
      _tag: "switch",
      selection: {
        instanceId: claude,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      },
    });
  });

  it("is quiet when the composer already runs the planner, even on a model the picker hides", () => {
    const hidden: UnifiedSettings = {
      ...settings,
      providerModelPreferences: { [superbot]: { hiddenModels: ["superbot"], modelOrder: [] } },
    };
    const selected = {
      instanceId: superbot,
      model: "superbot",
      options: [{ id: "effort", value: "high" }],
    };
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ settings: hidden, composer: { selected } }),
      }),
    ).toEqual({ _tag: "none" });
  });

  it("moves off the fallback onto the planner once the planner itself can run", () => {
    const toCodex = {
      _tag: "switch",
      selection: {
        instanceId: codex,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    };
    const loadout = withPlanner({
      instanceId: codex,
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
    });
    const onFallback = {
      instanceId: claude,
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "xhigh" }],
    };
    expect(
      plannerModelSwitch({
        pick: picked(loadout),
        loadout,
        picker: picker({ composer: { selected: onFallback } }),
      }),
    ).toEqual(toCodex);
    // A fallback with no effort of its own matches any effort on its model; it still moves.
    const plainFallback = withPlanner({
      instanceId: codex,
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: { instanceId: claude, model: "claude-opus-5-5" },
    });
    expect(
      plannerModelSwitch({
        pick: picked(plainFallback),
        loadout: plainFallback,
        picker: picker({ composer: { selected: onFallback } }),
      }),
    ).toEqual(toCodex);
  });

  it("puts back the planner's effort when only the effort was changed by hand", () => {
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({
          composer: {
            selected: {
              instanceId: superbot,
              model: "superbot",
              options: [{ id: "effort", value: "low" }],
            },
          },
        }),
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

  it("leaves the model alone while the model picker is disabled, and says so", () => {
    expect(
      plannerModelSwitch({
        pick: picked(oversight),
        loadout: oversight,
        picker: picker({ composer: { disabled: true } }),
      }),
    ).toEqual({
      _tag: "kept",
      reason:
        "Model picker is disabled, so this thread stays on its current model. Pick the loadout again once it is ready.",
    });
  });
});

describe("plannerRun", () => {
  const onPlanner = {
    instanceId: superbot,
    model: "superbot",
    options: [{ id: "effort", value: "high" }],
  };

  it("runs while the composer is on the planner at its effort", () => {
    expect(
      plannerRun({ loadout: oversight, picker: picker({ composer: { selected: onPlanner } }) }),
    ).toEqual({ _tag: "running", onFallback: false });
  });

  it("does not run while a new chat sends to several models at once", () => {
    const fanOut = [onPlanner, { instanceId: claude, model: "claude-opus-5-5" }];
    expect(
      plannerRun({
        loadout: oversight,
        picker: picker({ composer: { selected: onPlanner, fanOut } }),
      }),
    ).toEqual({
      _tag: "notRunning",
      reason:
        "This chat sends to 2 models at once, so the planner does not run. Pick the loadout again to send to the planner alone.",
    });
  });

  it("reports an effort changed by hand", () => {
    const lowered = { ...onPlanner, options: [{ id: "effort", value: "low" }] };
    expect(
      plannerRun({ loadout: oversight, picker: picker({ composer: { selected: lowered } }) }),
    ).toEqual({
      _tag: "notRunning",
      reason:
        "This thread runs superbot at low effort, not the planner's high. Pick the loadout again to switch.",
    });
  });

  it("says so once the model was changed by hand, or the loadout came without a switch", () => {
    expect(plannerRun({ loadout: oversight, picker: picker() })).toEqual({
      _tag: "notRunning",
      reason:
        "This thread runs on claude-sonnet-5-5, not its planner, superbot. Pick the loadout again to switch.",
    });
  });

  it("gives the reason when the planner cannot run on this thread", () => {
    expect(
      plannerRun({
        loadout: oversight,
        picker: picker({
          lock: { lockedProvider: codexDriver },
          composer: { selected: { instanceId: codex, model: "gpt-6.1-sol" } },
        }),
      }),
    ).toEqual({
      _tag: "notRunning",
      reason: "Superbot is unavailable in this thread. Start a new thread to switch providers.",
    });
  });

  it("does not run on the fallback once the planner itself can", () => {
    const loadout = withPlanner({
      instanceId: codex,
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
    });
    expect(
      plannerRun({
        loadout,
        picker: picker({
          composer: {
            selected: {
              instanceId: claude,
              model: "claude-opus-5-5",
              options: [{ id: "effort", value: "xhigh" }],
            },
          },
        }),
      }),
    ).toEqual({
      _tag: "notRunning",
      reason:
        "This thread runs on claude-opus-5-5, not its planner, gpt-6.1-sol. Pick the loadout again to switch.",
    });
  });

  it("does not promise a pick can fix the effort on a planner model the picker hides", () => {
    const hidden: UnifiedSettings = {
      ...settings,
      providerModelPreferences: { [superbot]: { hiddenModels: ["superbot"], modelOrder: [] } },
    };
    const lowered = { ...onPlanner, options: [{ id: "effort", value: "low" }] };
    const hiddenPicker = picker({ settings: hidden, composer: { selected: lowered } });
    expect(plannerRun({ loadout: oversight, picker: hiddenPicker })).toEqual({
      _tag: "notRunning",
      reason:
        "This thread runs superbot at low effort, not the planner's high. Set the effort in the composer; picking the loadout cannot change it here.",
    });
    expect(
      plannerModelSwitch({ pick: picked(oversight), loadout: oversight, picker: hiddenPicker }),
    ).toEqual({ _tag: "none" });
  });

  it("promises a fan-out can go back to the planner only when the planner can run there", () => {
    const projectOff: UnifiedSettings = {
      ...settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [superbot]: { enabled: false } } },
      },
    };
    const fanOut = [onPlanner, { instanceId: claude, model: "claude-opus-5-5" }];
    expect(
      plannerRun({
        loadout: oversight,
        picker: picker({ settings: projectOff, projectId, composer: { fanOut } }),
      }),
    ).toEqual({
      _tag: "notRunning",
      reason:
        "This chat sends to 2 models at once, so the planner does not run. Superbot is not available here. This thread stays on its current model.",
    });
  });

  it("knows nothing for a loadout without a planner or before the catalog loads", () => {
    const workersOnly: Loadout = { ...oversight, roles: { worker: oversight.roles.worker! } };
    expect(plannerRun({ loadout: workersOnly, picker: picker() })).toEqual({ _tag: "unknown" });
    expect(plannerRun({ loadout: oversight, picker: picker({ providers: [] }) })).toEqual({
      _tag: "unknown",
    });
  });
});

describe("loadoutAsRun", () => {
  it("names the fallback in the summary when the fallback is what runs", () => {
    const loadout = withPlanner({
      instanceId: codex,
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
    });
    // Locked to Claude, so the Codex planner cannot run and its fallback is the right one.
    const run = plannerRun({
      loadout,
      picker: picker({
        lock: { lockedProvider: claudeDriver },
        composer: {
          selected: {
            instanceId: claude,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "xhigh" }],
          },
        },
      }),
    });
    expect(run).toEqual({ _tag: "running", onFallback: true });
    expect(summarizeLoadoutRoles(loadoutAsRun(loadout, run))).toBe(
      "Opus xhigh plans · Haiku explores · Sonnet works · Opus high judges",
    );
  });

  it("leaves the planner out of the summary when it does not run", () => {
    const run = plannerRun({ loadout: oversight, picker: picker() });
    expect(summarizeLoadoutRoles(loadoutAsRun(oversight, run))).toBe(
      "Haiku explores · Sonnet works · Opus high judges",
    );
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

  const keepFanOut = () => {};

  it("moves through the model picker's path with the planner's effort, and is quiet once there", () => {
    const calls: Array<Parameters<SelectModel>> = [];
    const select: SelectModel = (...args) => {
      calls.push(args);
      return { instanceId: args[0], model: args[1], options: [{ id: "effort", value: "high" }] };
    };
    expect(applyPlannerModelSwitch(planner, { select, clearFanOut: keepFanOut })).toBeNull();
    expect(calls).toEqual([
      [
        superbot,
        "superbot",
        { focusComposer: false, optionOverrides: [{ id: "effort", value: "high" }] },
      ],
    ]);
  });

  it("clears a new chat's fan-out before selecting the planner, as the model picker does", () => {
    const steps: Array<string> = [];
    expect(
      applyPlannerModelSwitch(planner, {
        clearFanOut: () => steps.push("clear fan-out"),
        select: (instanceId, model) => {
          steps.push(`select ${model}`);
          return { instanceId, model };
        },
      }),
    ).toBeNull();
    expect(steps).toEqual(["clear fan-out", "select superbot"]);
  });

  it("reports a switch the model picker refused or landed elsewhere", () => {
    expect(applyPlannerModelSwitch(planner, { select: () => null, clearFanOut: keepFanOut })).toBe(
      "The model picker did not switch to superbot. This thread stays on its current model.",
    );
    expect(
      applyPlannerModelSwitch(planner, {
        select: () => ({ instanceId: superbot, model: "superbot-mini" }),
        clearFanOut: keepFanOut,
      }),
    ).toBe("The model picker chose superbot-mini instead of the planner, superbot.");
  });

  it("passes a kept reason through without touching the model, and stays quiet for none", () => {
    const untouched = {
      select: () => {
        throw new Error("the model must not move");
      },
      clearFanOut: () => {
        throw new Error("the fan-out must stay");
      },
    };
    expect(applyPlannerModelSwitch({ _tag: "kept", reason: "Locked." }, untouched)).toBe("Locked.");
    expect(applyPlannerModelSwitch({ _tag: "none" }, untouched)).toBeNull();
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
