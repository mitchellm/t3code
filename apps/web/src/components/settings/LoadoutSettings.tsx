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

import { randomUUID } from "../../lib/utils";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsRow,
  SettingResetButton,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  duplicateLoadout,
  effortChoices,
  missingPresets,
  newRoleDefault,
  roleAfterModelChange,
  sameLoadout,
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

const DEFAULT_EFFORT = "__default__";

const newId = () => `custom-${randomUUID()}`;

const isBuiltIn = (loadout: Loadout) =>
  DEFAULT_LOADOUTS.some((builtIn) => sameLoadout(builtIn, loadout));

function RoleRow(props: {
  name: LoadoutRoleName;
  loadout: Loadout;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptions: ReturnType<typeof getCustomModelOptionsByInstance>;
  environmentId: Parameters<typeof ProviderModelPicker>[0]["environmentId"];
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
  const efforts = effortChoices(model);

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
      {/* Only effort is stored on a role, so only effort is offered (TraitsPicker would also list thinking, fast mode and context, which would snap back). */}
      {efforts.length > 0 ? (
        <Select
          value={role.effort ?? DEFAULT_EFFORT}
          onValueChange={(value) => {
            const { effort: _previous, ...rest } = role;
            props.onChange(
              withRole(
                loadout,
                name,
                value === null || value === DEFAULT_EFFORT ? rest : { ...rest, effort: value },
              ),
            );
          }}
        >
          <SelectTrigger size="sm" className="w-fit" aria-label={`${ROLE_LABELS[name]} effort`}>
            <SelectValue>
              {efforts.find(({ id }) => id === role.effort)?.label ?? "Default effort"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={DEFAULT_EFFORT} hideIndicator>
              Default effort
            </SelectItem>
            {efforts.map(({ id, label }) => (
              <SelectItem key={id} value={id} hideIndicator>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
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
  onChange: (loadout: Loadout) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { loadout } = props;
  const addable = unassignedRoles(loadout);
  const roleDefault = newRoleDefault(props.entries);
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
          onChange={props.onChange}
        />
      ))}
      {addable.length === 0 || loadout.id === SOLO_LOADOUT_ID ? null : (
        // The span carries the tooltip because a disabled trigger swallows hover.
        <Tooltip>
          <TooltipTrigger render={<span className="w-fit" />}>
            <Select
              value={null}
              disabled={roleDefault === undefined}
              onValueChange={(value) => {
                const name = LOADOUT_ROLE_NAMES.find((candidate) => candidate === value);
                if (name === undefined || roleDefault === undefined) return;
                props.onChange(withRole(loadout, name, roleDefault));
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
          </TooltipTrigger>
          {roleDefault === undefined ? (
            <TooltipPopup side="top">
              A role needs a model, and no provider models are loaded here. Connect an environment
              with an enabled provider first.
            </TooltipPopup>
          ) : null}
        </Tooltip>
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
  // Ids are only minted when a preset is actually added, so render stays pure.
  const presetsToAdd = missingPresets(loadouts, DEFAULT_LOADOUTS, () => "");

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
        <div className="flex flex-wrap items-center gap-2">
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
          {presetsToAdd.length === 0 ? null : (
            <Select
              value={null}
              onValueChange={(value) => {
                const preset = missingPresets(loadouts, DEFAULT_LOADOUTS, newId).find(
                  ({ name }) => name === value,
                );
                if (preset !== undefined) save([...loadouts, preset]);
              }}
            >
              <SelectTrigger size="sm" className="w-fit" aria-label="Add preset">
                <PlusIcon className="size-4" />
                <SelectValue>Add preset</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {presetsToAdd.map((preset) => (
                  <SelectItem key={preset.name} value={preset.name} hideIndicator>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </div>
      </div>
    </SettingsRow>
  );
}
