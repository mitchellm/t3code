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
import { loadoutRoleCandidates, roleEffortOptions } from "@t3tools/shared/loadouts";
import { resolveSelectableModel } from "@t3tools/shared/model";

import type { AppModelOption } from "../../modelSelection";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

/**
 * The model picker's own inputs: entries with this project's enablement applied, and per instance
 * the models it lists (hidden ones removed, custom ones added). A planner it would not offer is
 * never switched to, since the picker's path would quietly land on another model instead.
 */
export interface PlannerPicker {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly modelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
}

export type PlannerModelSwitch =
  | { readonly _tag: "none" }
  | { readonly _tag: "switch"; readonly selection: ModelSelection }
  | { readonly _tag: "kept"; readonly reason: string };

type PlannerOffer =
  | {
      readonly _tag: "offered";
      readonly entry: ProviderInstanceEntry;
      readonly name: string;
      readonly selection: ModelSelection;
    }
  | { readonly _tag: "unoffered"; readonly reason: string };

const NONE: PlannerModelSwitch = { _tag: "none" };

function offer(candidate: Omit<LoadoutRole, "fallback">, picker: PlannerPicker): PlannerOffer {
  const entry = picker.entries.find(({ instanceId }) => instanceId === candidate.instanceId);
  if (entry === undefined || !isProviderInstancePickerReady(entry)) {
    return {
      _tag: "unoffered",
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
      _tag: "unoffered",
      reason: `${entry.displayName} does not offer ${candidate.model} in the model picker. This thread stays on its current model.`,
    };
  }
  const options = roleEffortOptions(
    entry.models.find((model) => model.slug === slug),
    candidate.effort,
  );
  return {
    _tag: "offered",
    entry,
    name: option.name,
    selection: {
      instanceId: entry.instanceId,
      model: slug,
      ...(options.length > 0 ? { options } : {}),
    },
  };
}

/** The role's own model, else its fallback; a role neither resolves for reports its own reason. */
function plannerOffer(loadout: Loadout, picker: PlannerPicker): PlannerOffer | null {
  const planner = loadout.roles.planner;
  // Before the catalog loads every provider reads as missing, which is not the planner being gone.
  if (planner === undefined || picker.entries.length === 0) return null;
  const { fallback, ...own } = planner;
  const first = offer(own, picker);
  if (first._tag === "offered" || fallback === undefined) return first;
  const second = offer(fallback, picker);
  return second._tag === "offered" ? second : first;
}

/** Why the model picker would refuse this move on this thread, in the picker's own words. */
function lockReason(
  offered: Extract<PlannerOffer, { _tag: "offered" }>,
  picker: PlannerPicker,
): string | null {
  const { lockedProvider, lockedContinuationGroupKey } = picker;
  const locked =
    lockedProvider !== null &&
    (offered.entry.driverKind !== lockedProvider ||
      (Boolean(lockedContinuationGroupKey) &&
        offered.entry.continuationGroupKey !== lockedContinuationGroupKey));
  if (locked) {
    return `${offered.entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`;
  }
  return picker.modelDisabledReason(offered.selection.instanceId, offered.selection.model);
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
  if (input.pick?.setBy !== "user") return NONE;
  const offered = plannerOffer(input.loadout, input.picker);
  if (offered === null) return NONE;
  if (offered._tag === "unoffered") return { _tag: "kept", reason: offered.reason };
  const locked = lockReason(offered, input.picker);
  return locked === null
    ? { _tag: "switch", selection: offered.selection }
    : { _tag: "kept", reason: locked };
}

/**
 * Why the composer is not on the active loadout's planner, read from the model it is actually on,
 * so a model changed by hand or a loadout set without a pick is reported too. Null when it is.
 */
export function plannerNotRunning(input: {
  readonly loadout: Loadout;
  readonly picker: PlannerPicker;
  readonly actual: { readonly instanceId: ProviderInstanceId; readonly model: string };
}): string | null {
  const { actual, picker } = input;
  const planner = input.loadout.roles.planner;
  const onCandidate =
    planner !== undefined &&
    loadoutRoleCandidates(planner).some(
      ({ providerInstanceId, model }) =>
        providerInstanceId === actual.instanceId && model === actual.model,
    );
  const offered = onCandidate ? null : plannerOffer(input.loadout, picker);
  if (offered === null) return null;
  if (offered._tag === "unoffered") return offered.reason;
  if (
    offered.selection.instanceId === actual.instanceId &&
    offered.selection.model === actual.model
  ) {
    return null;
  }
  const actualName =
    picker.modelOptionsByInstance.get(actual.instanceId)?.find(({ slug }) => slug === actual.model)
      ?.name ?? actual.model;
  return (
    lockReason(offered, picker) ??
    `This thread runs on ${actualName}, not its planner, ${offered.name}. Pick the loadout again to switch.`
  );
}

export type SelectModel = (
  instanceId: ProviderInstanceId,
  model: string,
  options?: { focusComposer?: boolean; optionOverrides?: ModelSelection["options"] },
) => ModelSelection | null;

/**
 * Makes the move through the model picker's path and judges it by what that path reports it set,
 * not by the prediction. Null once the composer is on the planner, else what to tell the user.
 */
export function applyPlannerModelSwitch(
  decision: PlannerModelSwitch,
  select: SelectModel,
): string | null {
  if (decision._tag !== "switch") return decision._tag === "kept" ? decision.reason : null;
  const { instanceId, model, options } = decision.selection;
  const applied = select(instanceId, model, { focusComposer: false, optionOverrides: options });
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
