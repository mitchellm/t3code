/**
 * Fork: a loadout's planner is the top-level thread itself, not a delegated role, so picking a
 * loadout moves the composer onto the planner's model. The move goes through the model picker's
 * own path and locks; this decides whether it can happen and what to say when it cannot.
 */
import type {
  Loadout,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ThreadLoadout,
} from "@t3tools/contracts";
import { loadoutModelShortName } from "@t3tools/shared/loadoutSummary";
import { type LoadoutProviderView, loadoutRoleTarget } from "@t3tools/shared/loadouts";

export interface PlannerProviderView extends LoadoutProviderView {
  readonly driver: ProviderDriverKind;
  readonly continuation?: { readonly groupKey: string } | undefined;
}

/** What the model picker is held to on this thread: the same three inputs it disables entries by. */
export interface PlannerLock {
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly modelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
}

export type PlannerModelSwitch =
  | { readonly _tag: "none" }
  | { readonly _tag: "switch"; readonly selection: ModelSelection }
  | { readonly _tag: "kept"; readonly reason: string };

const NONE: PlannerModelSwitch = { _tag: "none" };

/**
 * Only the user's own pick moves the model: Clear hands the slot back, and an agent proposal must
 * not swap the model out from under the person typing.
 */
export function plannerModelSwitch(input: {
  readonly pick: ThreadLoadout | null;
  readonly loadout: Loadout;
  readonly providers: ReadonlyArray<PlannerProviderView>;
  readonly lock: PlannerLock;
}): PlannerModelSwitch {
  const planner = input.loadout.roles.planner;
  if (input.pick?.setBy !== "user" || planner === undefined) return NONE;
  // Before the catalog loads every provider reads as missing, which is not the planner being gone.
  if (input.providers.length === 0) return NONE;
  const target = loadoutRoleTarget(planner, input.providers);
  const instanceId = target?.providerInstanceId;
  const model = target?.model;
  if (instanceId === undefined || model === undefined) {
    return {
      _tag: "kept",
      reason: `The planner, ${loadoutModelShortName(planner.model)}, is not available here, so this thread stays on its current model.`,
    };
  }
  const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
  const { lockedProvider, lockedContinuationGroupKey } = input.lock;
  if (
    (lockedProvider !== null && provider?.driver !== lockedProvider) ||
    (lockedContinuationGroupKey !== null &&
      provider?.continuation?.groupKey !== lockedContinuationGroupKey)
  ) {
    return {
      _tag: "kept",
      reason: `This thread is locked to its provider, so it stays on its current model. Start a new chat to plan on ${loadoutModelShortName(model)}.`,
    };
  }
  const disabled = input.lock.modelDisabledReason(instanceId, model);
  if (disabled !== null) {
    return { _tag: "kept", reason: `This thread stays on its current model. ${disabled}` };
  }
  const options = target?.options;
  return {
    _tag: "switch",
    selection: { instanceId, model, ...(options === undefined ? {} : { options }) },
  };
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
