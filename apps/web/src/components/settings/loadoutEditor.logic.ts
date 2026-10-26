// Fork: pure helpers behind the loadout editor.
import {
  LOADOUT_ROLE_NAMES,
  type Loadout,
  type LoadoutRole,
  type LoadoutRoleName,
  type ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["effort", "reasoningEffort"]);

interface ModelWithOptions {
  readonly slug: string;
  readonly capabilities?:
    | {
        readonly optionDescriptors?:
          | ReadonlyArray<{
              readonly id: string;
              readonly type: string;
              readonly options?: ReadonlyArray<{ readonly id: string }> | undefined;
            }>
          | undefined;
      }
    | null
    | undefined;
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

const effortDescriptor = (model: ModelWithOptions | undefined) =>
  model?.capabilities?.optionDescriptors?.find(
    (descriptor) => EFFORT_OPTION_IDS.has(descriptor.id) && descriptor.type === "select",
  );

/** The id of the effort option this model advertises, which differs per driver. */
export const effortOptionId = (model: ModelWithOptions | undefined): string | undefined =>
  effortDescriptor(model)?.id;

export function effortFromSelections(
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
): string | undefined {
  const found = selections?.find(({ id }) => EFFORT_OPTION_IDS.has(id));
  return typeof found?.value === "string" ? found.value : undefined;
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
