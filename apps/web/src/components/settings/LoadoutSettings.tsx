import {
  DEFAULT_LOADOUTS,
  LOADOUT_ROLE_NAMES,
  type Loadout,
  type LoadoutRoleName,
  type ProviderInstanceId,
  SOLO_LOADOUT_ID,
} from "@t3tools/contracts";
import { loadoutRoleIssue, type LoadoutRoleIssueKind } from "@t3tools/shared/loadoutSummary";
import { CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingsRow,
  SettingResetButton,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  duplicateLoadout,
  effortFromSelections,
  effortOptionId,
  roleAfterModelChange,
  unassignedRoles,
  withRole,
} from "./loadoutEditor.logic";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const ROLE_LABELS: Record<LoadoutRoleName, string> = {
  planner: "Planner",
  subPlanner: "Sub-planner",
  explorer: "Explorer",
  worker: "Worker",
  judge: "Judge",
};

const ISSUE_LABELS: Record<LoadoutRoleIssueKind, string> = {
  missing_instance: "Provider not found",
  disabled_instance: "Provider disabled",
  missing_model: "Model not offered",
};

const newId = () => `custom-${Date.now().toString(36)}`;

const isBuiltIn = (loadout: Loadout) =>
  DEFAULT_LOADOUTS.some((builtIn) => JSON.stringify(builtIn) === JSON.stringify(loadout));

function RoleRow(props: {
  name: LoadoutRoleName;
  loadout: Loadout;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptions: ReturnType<typeof getCustomModelOptionsByInstance>;
  environmentId: Parameters<typeof ProviderModelPicker>[0]["environmentId"];
  planModeEnabled: boolean;
  onChange: (loadout: Loadout) => void;
}) {
  const { name, loadout, entries } = props;
  const role = loadout.roles[name];
  if (role === undefined) return null;
  const entry = entries.find(({ instanceId }) => instanceId === role.instanceId);
  const model = entry?.models.find(({ slug }) => slug === role.model);
  // With no catalog (no connected environment) nothing can be judged, so no warning is shown.
  const issue =
    entries.length === 0
      ? null
      : loadoutRoleIssue(
          role,
          entries.map((candidate) => ({
            instanceId: candidate.instanceId,
            enabled: candidate.enabled && candidate.isAvailable,
            models: candidate.models,
          })),
        );
  const optionId = effortOptionId(model) ?? "effort";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-muted-foreground text-xs">{ROLE_LABELS[name]}</span>
      <ProviderModelPicker
        environmentId={props.environmentId}
        activeInstanceId={role.instanceId}
        model={role.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={props.modelOptions}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        onInstanceModelChange={(instanceId: ProviderInstanceId, slug: string) =>
          props.onChange(
            withRole(
              loadout,
              name,
              roleAfterModelChange(
                role,
                instanceId,
                slug,
                entries
                  .find((candidate) => candidate.instanceId === instanceId)
                  ?.models.find((candidate) => candidate.slug === slug),
              ),
            ),
          )
        }
      />
      {entry !== undefined && model !== undefined ? (
        <TraitsPicker
          provider={entry.driverKind}
          instanceId={entry.instanceId}
          models={entry.models}
          model={role.model}
          modelOptions={role.effort === undefined ? [] : [{ id: optionId, value: role.effort }]}
          allowPromptInjectedEffort={false}
          planModeEnabled={props.planModeEnabled}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onModelOptionsChange={(options) => {
            const effort = effortFromSelections(options);
            const { effort: _previous, ...rest } = role;
            props.onChange(
              withRole(loadout, name, effort === undefined ? rest : { ...rest, effort }),
            );
          }}
        />
      ) : null}
      {issue === null ? null : (
        <Badge variant="warning" size="sm">
          {ISSUE_LABELS[issue]}
        </Badge>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className="ml-auto"
        aria-label={`Remove ${ROLE_LABELS[name]} from ${loadout.name}`}
        onClick={() => props.onChange(withRole(loadout, name, undefined))}
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}

function LoadoutEditor(props: {
  loadout: Loadout;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptions: ReturnType<typeof getCustomModelOptionsByInstance>;
  environmentId: Parameters<typeof ProviderModelPicker>[0]["environmentId"];
  planModeEnabled: boolean;
  onChange: (loadout: Loadout) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { loadout } = props;
  const addable = unassignedRoles(loadout);
  const fallbackEntry = props.entries.find(({ enabled, models }) => enabled && models.length > 0);
  return (
    <div className="grid gap-2 border-t border-border/60 px-1 py-3 first:border-t-0">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Loadout name"
          defaultValue={loadout.name}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name !== "" && name !== loadout.name) props.onChange({ ...loadout, name });
          }}
        />
        {isBuiltIn(loadout) ? (
          <span className="shrink-0 text-muted-foreground text-xs">Built-in</span>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Duplicate ${loadout.name}`}
          onClick={props.onDuplicate}
        >
          <CopyIcon className="size-4" />
        </Button>
        {/* Solo is the way back to no roles, so it stays. */}
        {loadout.id === SOLO_LOADOUT_ID ? null : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${loadout.name}`}
            onClick={props.onRemove}
          >
            <Trash2Icon className="size-4" />
          </Button>
        )}
      </div>
      <Input
        aria-label="Loadout description"
        defaultValue={loadout.description}
        placeholder="When this structure is worth its cost"
        onBlur={(event) => {
          if (event.target.value !== loadout.description) {
            props.onChange({ ...loadout, description: event.target.value });
          }
        }}
      />
      {LOADOUT_ROLE_NAMES.map((name) => (
        <RoleRow
          key={name}
          name={name}
          loadout={loadout}
          entries={props.entries}
          modelOptions={props.modelOptions}
          environmentId={props.environmentId}
          planModeEnabled={props.planModeEnabled}
          onChange={props.onChange}
        />
      ))}
      {addable.length === 0 || loadout.id === SOLO_LOADOUT_ID ? null : (
        <Select
          value={null}
          onValueChange={(value) => {
            const name = LOADOUT_ROLE_NAMES.find((candidate) => candidate === value);
            const model = fallbackEntry?.models[0];
            if (name === undefined || fallbackEntry === undefined || model === undefined) return;
            props.onChange(
              withRole(loadout, name, { instanceId: fallbackEntry.instanceId, model: model.slug }),
            );
          }}
        >
          <SelectTrigger size="sm" className="w-fit" aria-label={`Add role to ${loadout.name}`}>
            <PlusIcon className="size-4" />
            <SelectValue>Add role</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {addable.map((name) => (
              <SelectItem key={name} value={name} hideIndicator>
                {ROLE_LABELS[name]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
    </div>
  );
}

export function LoadoutSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["loadouts"]);
  const { target } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target?.projectId ?? null,
    ),
  );
  const modelOptions = getCustomModelOptionsByInstance(settings, providers);
  const loadouts = settings.loadouts;
  const save = (next: ReadonlyArray<Loadout>) => updateSettings({ loadouts: [...next] });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["loadouts"]}
      {...searchableSetting("loadouts")}
      description="Named agent structures a thread can run under. Every thread starts solo; roles take effect when the thread picks a loadout. An empty role runs on the thread's own model."
      resetAction={
        mixed || JSON.stringify(loadouts) !== JSON.stringify(DEFAULT_LOADOUTS) ? (
          <SettingResetButton label="loadouts" onClick={() => save(DEFAULT_LOADOUTS)} />
        ) : null
      }
    >
      <div className="mt-3 max-w-3xl pb-3.5">
        {mixed ? (
          <p className="pb-2 text-muted-foreground text-xs">
            Selected targets differ. Editing applies the list shown to all of them.
          </p>
        ) : null}
        {loadouts.map((loadout) => (
          <LoadoutEditor
            key={`${loadout.id}:${loadout.name}:${loadout.description}`}
            loadout={loadout}
            entries={entries}
            modelOptions={modelOptions}
            environmentId={representative?.environmentId ?? null}
            planModeEnabled={settings.planModeEnabled}
            onChange={(next) =>
              save(loadouts.map((candidate) => (candidate.id === loadout.id ? next : candidate)))
            }
            onDuplicate={() => {
              const copy = duplicateLoadout(loadout, loadouts, newId());
              const at = loadouts.findIndex((candidate) => candidate.id === loadout.id);
              save([...loadouts.slice(0, at + 1), copy, ...loadouts.slice(at + 1)]);
            }}
            onRemove={() => save(loadouts.filter((candidate) => candidate.id !== loadout.id))}
          />
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            save([...loadouts, { id: newId(), name: "New loadout", description: "", roles: {} }])
          }
        >
          <PlusIcon className="size-4" />
          Add loadout
        </Button>
      </div>
    </SettingsRow>
  );
}
