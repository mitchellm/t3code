// Fork: pure helpers behind the loadout editor.
import {
  LOADOUT_ROLE_NAMES,
  type Loadout,
  type LoadoutRole,
  type LoadoutRoleName,
  type ProviderInstanceId,
  SOLO_LOADOUT_ID,
} from "@t3tools/contracts";

import { EFFORT_OPTION_IDS } from "@t3tools/shared/loadouts";

interface ModelWithOptions {
  readonly slug: string;
  readonly capabilities?:
    | {
        readonly optionDescriptors?:
          | ReadonlyArray<{
              readonly id: string;
              readonly type: string;
              readonly options?:
                | ReadonlyArray<{ readonly id: string; readonly label?: string | undefined }>
                | undefined;
            }>
          | undefined;
      }
    | null
    | undefined;
}

/** The effort options a model advertises, and only those: thinking, fast mode and context are not saved by a role. */
const effortDescriptor = (model: ModelWithOptions | undefined) =>
  model?.capabilities?.optionDescriptors?.find(
    (descriptor) => EFFORT_OPTION_IDS.has(descriptor.id) && descriptor.type === "select",
  );

export function effortChoices(
  model: ModelWithOptions | undefined,
): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  return (effortDescriptor(model)?.options ?? []).map(({ id, label }) => ({
    id,
    label: label ?? id,
  }));
}

/** Where a freshly added role starts. Undefined without a catalog, since a role needs a model. */
export function newRoleDefault(
  entries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<{ readonly slug: string }>;
  }>,
): LoadoutRole | undefined {
  const entry = entries.find(
    ({ enabled, isAvailable, models }) => enabled && isAvailable && models.length > 0,
  );
  const model = entry?.models[0];
  return entry === undefined || model === undefined
    ? undefined
    : { instanceId: entry.instanceId, model: model.slug };
}

const sameLoadoutShape = (a: Loadout, b: Loadout) =>
  a.name === b.name && JSON.stringify(a.roles) === JSON.stringify(b.roles);

/**
 * Presets the saved list does not hold, for users whose stored list predates them. A preset
 * counts as held when a loadout has its name and roles, so an edited copy is offered again; the
 * copy keeps the preset id when unused and takes a fresh one otherwise.
 */
export function missingPresets(
  existing: ReadonlyArray<Loadout>,
  presets: ReadonlyArray<Loadout>,
  mintId: () => string,
): ReadonlyArray<Loadout> {
  const taken = new Set(existing.map(({ id }) => id));
  return presets
    .filter((preset) => preset.id !== SOLO_LOADOUT_ID)
    .filter((preset) => !existing.some((candidate) => sameLoadoutShape(candidate, preset)))
    .map((preset) => {
      const id = taken.has(preset.id) ? mintId() : preset.id;
      taken.add(id);
      return { ...preset, id };
    });
}

/**
 * The settings scope that holds the list a project's threads use: its own when it overrides
 * loadouts, otherwise the environment's.
 */
export function loadoutSettingsScopeSearch(input: {
  readonly environmentId: string;
  readonly projectOverridden: boolean;
  readonly projectKey: string | null;
}): { project?: string; machine: string } {
  return input.projectOverridden && input.projectKey !== null
    ? { project: input.projectKey, machine: input.environmentId }
    : { machine: input.environmentId };
}

export function withRole(
  loadout: Loadout,
  name: LoadoutRoleName,
  role: LoadoutRole | undefined,
): Loadout {
  const { [name]: _replaced, ...others } = loadout.roles;
  return { ...loadout, roles: role === undefined ? others : { ...others, [name]: role } };
}

export const unassignedRoles = (loadout: Loadout): ReadonlyArray<LoadoutRoleName> =>
  LOADOUT_ROLE_NAMES.filter((name) => loadout.roles[name] === undefined);

/** The copy gets a fresh id and a name no other loadout uses ("X copy", "X copy 2", ...). */
export function duplicateLoadout(
  loadout: Loadout,
  existing: ReadonlyArray<Loadout>,
  id: string,
): Loadout {
  const taken = new Set(existing.map(({ name }) => name));
  let name = `${loadout.name} copy`;
  for (let attempt = 2; taken.has(name); attempt += 1) name = `${loadout.name} copy ${attempt}`;
  return { ...loadout, id, name };
}

/**
 * A role after its provider or model changed. The old effort survives only if the new model
 * offers it; otherwise it is dropped here rather than saved as a value that is ignored at use.
 */
export function roleAfterModelChange(
  previous: LoadoutRole | undefined,
  instanceId: ProviderInstanceId,
  modelSlug: string,
  model: ModelWithOptions | undefined,
): LoadoutRole {
  const keep =
    previous?.effort !== undefined &&
    effortDescriptor(model)?.options?.some(({ id }) => id === previous.effort) === true;
  return {
    instanceId,
    model: modelSlug,
    ...(keep && previous?.effort !== undefined ? { effort: previous.effort } : {}),
  };
}
