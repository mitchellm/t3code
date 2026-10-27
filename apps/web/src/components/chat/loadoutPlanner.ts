/**
 * Fork: a loadout's planner is the top-level thread itself, not a delegated role, so picking a
 * loadout moves the composer onto the planner's model. The move goes through the model picker's
 * own path and locks; this decides whether it can happen and what to say when it cannot.
 */
import type {
  Loadout,
  LoadoutRole,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ThreadLoadout,
} from "@t3tools/contracts";
import { roleEffortOptions } from "@t3tools/shared/loadouts";
import { resolveSelectableModel } from "@t3tools/shared/model";

import type { AppModelOption } from "../../modelSelection";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

/**
 * The model picker as the composer holds it: entries with this project's enablement applied, the
 * models it lists per instance (hidden removed, custom added), its locks and disabled state, and
 * what the next send uses. A planner it would not offer is never switched to, since the picker's
 * path would quietly land on another model instead.
 */
export interface PlannerPicker {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly modelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  /** The catalog is loading or a send is in flight, so the picker itself takes no choice. */
  readonly disabled: boolean;
  readonly selected: ModelSelection;
  /** The models a new chat sends to at once; when set, these run instead of `selected`. */
  readonly fanOut: ReadonlyArray<ModelSelection> | null;
}

export type PlannerModelSwitch =
  | { readonly _tag: "none" }
  | { readonly _tag: "switch"; readonly selection: ModelSelection }
  | { readonly _tag: "kept"; readonly reason: string };

export type PlannerRun =
  | { readonly _tag: "unknown" }
  | { readonly _tag: "running"; readonly onFallback: boolean }
  | { readonly _tag: "notRunning"; readonly reason: string };

type RoleModel = Omit<LoadoutRole, "fallback">;

type Candidate =
  | {
      readonly _tag: "usable";
      readonly name: string;
      readonly selection: ModelSelection;
    }
  | { readonly _tag: "blocked"; readonly reason: string };

const NONE: PlannerModelSwitch = { _tag: "none" };

const DISABLED_REASON =
  "Model picker is disabled, so this thread stays on its current model. Pick the loadout again once it is ready.";

/** A role model as the picker offers it on this thread, or why it does not, in its own words. */
function usable(candidate: RoleModel, picker: PlannerPicker): Candidate {
  const entry = picker.entries.find(({ instanceId }) => instanceId === candidate.instanceId);
  if (entry === undefined || !isProviderInstancePickerReady(entry)) {
    return {
      _tag: "blocked",
      reason: `${entry?.displayName ?? candidate.instanceId} is not available here. This thread stays on its current model.`,
    };
  }
  const listed = (picker.modelOptionsByInstance.get(entry.instanceId) ?? []).filter(
    ({ isUnavailable }) => isUnavailable !== true,
  );
  const slug = resolveSelectableModel(entry.driverKind, candidate.model, listed);
  const option = listed.find((listedOption) => listedOption.slug === slug);
  if (slug === null || option === undefined) {
    return {
      _tag: "blocked",
      reason: `${entry.displayName} does not offer ${candidate.model} in the model picker. This thread stays on its current model.`,
    };
  }
  const { lockedProvider, lockedContinuationGroupKey } = picker;
  // ModelPickerContent's matchesLockedProvider, so the picker and this agree on what is locked.
  if (
    lockedProvider !== null &&
    (entry.driverKind !== lockedProvider ||
      (Boolean(lockedContinuationGroupKey) &&
        entry.continuationGroupKey !== lockedContinuationGroupKey))
  ) {
    return {
      _tag: "blocked",
      reason: `${entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`,
    };
  }
  const disabled = picker.modelDisabledReason(entry.instanceId, slug);
  if (disabled !== null) return { _tag: "blocked", reason: disabled };
  const options = roleEffortOptions(
    entry.models.find((model) => model.slug === slug),
    candidate.effort,
  );
  return {
    _tag: "usable",
    name: option.name,
    selection: {
      instanceId: entry.instanceId,
      model: slug,
      ...(options.length > 0 ? { options } : {}),
    },
  };
}

/** The planner's own model, else its fallback; when neither can run, the planner's own reason. */
function plannerChoice(planner: LoadoutRole, picker: PlannerPicker): Candidate {
  const { fallback, ...own } = planner;
  const first = usable(own, picker);
  if (first._tag === "usable" || fallback === undefined) return first;
  const second = usable(fallback, picker);
  return second._tag === "usable" ? second : first;
}

/** Which of the planner's models the single selection is on, and the effort it differs by, if any. */
function onPlanner(planner: LoadoutRole, picker: PlannerPicker) {
  const { fallback, ...own } = planner;
  const { selected } = picker;
  const candidates = fallback === undefined ? [own] : [own, fallback];
  const on = candidates.find(
    ({ instanceId, model }) => instanceId === selected.instanceId && model === selected.model,
  );
  if (on === undefined) return null;
  const entry = picker.entries.find(({ instanceId }) => instanceId === on.instanceId);
  const [wanted] = roleEffortOptions(
    entry?.models.find(({ slug }) => slug === on.model),
    on.effort,
  );
  const actual = selected.options?.find(({ id }) => id === wanted?.id)?.value;
  return {
    onFallback: on !== own,
    effortOff:
      wanted === undefined || actual === wanted.value
        ? null
        : { wanted: String(wanted.value), actual: actual === undefined ? null : String(actual) },
  };
}

function selectedName(picker: PlannerPicker): string {
  const { instanceId, model } = picker.selected;
  return (
    picker.modelOptionsByInstance.get(instanceId)?.find(({ slug }) => slug === model)?.name ?? model
  );
}

/**
 * Only the user's own pick moves the model: Clear hands the slot back, and an agent proposal must
 * not swap the model out from under the person typing.
 */
export function plannerModelSwitch(input: {
  readonly pick: ThreadLoadout | null;
  readonly loadout: Loadout;
  readonly picker: PlannerPicker;
}): PlannerModelSwitch {
  const { picker } = input;
  const planner = input.loadout.roles.planner;
  // Before the catalog loads every provider reads as missing, which is not the planner being gone.
  if (input.pick?.setBy !== "user" || planner === undefined || picker.entries.length === 0) {
    return NONE;
  }
  const on = picker.fanOut === null ? onPlanner(planner, picker) : null;
  // Already there: nothing moves, and a planner model the picker hides is not reported missing.
  if (on !== null && on.effortOff === null) return NONE;
  if (picker.disabled) return { _tag: "kept", reason: DISABLED_REASON };
  const choice = plannerChoice(planner, picker);
  if (choice._tag === "usable") return { _tag: "switch", selection: choice.selection };
  return on === null ? { _tag: "kept", reason: choice.reason } : NONE;
}

/**
 * Whether the composer's next send runs on the active loadout's planner, read from what it holds,
 * so a fan-out, a model or effort changed by hand, or a loadout set without a pick all show.
 */
export function plannerRun(input: {
  readonly loadout: Loadout;
  readonly picker: PlannerPicker;
}): PlannerRun {
  const { picker } = input;
  const planner = input.loadout.roles.planner;
  if (planner === undefined || picker.entries.length === 0) return { _tag: "unknown" };
  if (picker.fanOut !== null) {
    const count = picker.fanOut.length >= 2 ? `${picker.fanOut.length}` : "several";
    return {
      _tag: "notRunning",
      reason: `This chat sends to ${count} models at once, so the planner does not run. Pick the loadout again to send to the planner alone.`,
    };
  }
  const on = onPlanner(planner, picker);
  if (on !== null) {
    if (on.effortOff === null) return { _tag: "running", onFallback: on.onFallback };
    return {
      _tag: "notRunning",
      reason: `This thread runs ${selectedName(picker)} at ${on.effortOff.actual ?? "its default"} effort, not the planner's ${on.effortOff.wanted}. Pick the loadout again to switch.`,
    };
  }
  const choice = plannerChoice(planner, picker);
  return {
    _tag: "notRunning",
    reason:
      choice._tag === "blocked"
        ? choice.reason
        : `This thread runs on ${selectedName(picker)}, not its planner, ${choice.name}. Pick the loadout again to switch.`,
  };
}

/** The loadout as it runs, for its summary: the fallback if that plans, no planner if none does. */
export function loadoutAsRun(loadout: Loadout, run: PlannerRun): Loadout {
  const { planner, ...rest } = loadout.roles;
  if (run._tag === "notRunning") return { ...loadout, roles: rest };
  if (run._tag === "running" && run.onFallback && planner?.fallback !== undefined) {
    return { ...loadout, roles: { ...rest, planner: planner.fallback } };
  }
  return loadout;
}

export type SelectModel = (
  instanceId: ProviderInstanceId,
  model: string,
  options?: { focusComposer?: boolean; optionOverrides?: ModelSelection["options"] },
) => ModelSelection | null;

/** The model picker's two moves: picking one model, and dropping a new chat's fan-out. */
export interface PlannerComposer {
  readonly select: SelectModel;
  readonly clearFanOut: () => void;
}

/**
 * Makes the move as the model picker does, fan-out dropped first so the planner is what sends,
 * and judges it by what the picker's path reports it set, not by the prediction. Null once the
 * composer is on the planner, else what to tell the user.
 */
export function applyPlannerModelSwitch(
  decision: PlannerModelSwitch,
  composer: PlannerComposer,
): string | null {
  if (decision._tag !== "switch") return decision._tag === "kept" ? decision.reason : null;
  const { instanceId, model, options } = decision.selection;
  composer.clearFanOut();
  const applied = composer.select(instanceId, model, {
    focusComposer: false,
    optionOverrides: options,
  });
  if (applied === null) {
    return `The model picker did not switch to ${model}. This thread stays on its current model.`;
  }
  return applied.instanceId === instanceId && applied.model === model
    ? null
    : `The model picker chose ${applied.model} instead of the planner, ${model}.`;
}

/** The planner sets effort only; whatever else the user last chose for that model still applies. */
export function withOptionOverrides(
  remembered: ReadonlyArray<ProviderOptionSelection> | undefined,
  overrides: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (overrides === undefined || overrides.length === 0) return remembered;
  const base = remembered ?? [];
  return [
    ...base.map((option) => overrides.find(({ id }) => id === option.id) ?? option),
    ...overrides.filter(({ id }) => !base.some((option) => option.id === id)),
  ];
}
