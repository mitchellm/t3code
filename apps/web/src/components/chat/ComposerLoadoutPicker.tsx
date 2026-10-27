import type { Loadout } from "@t3tools/contracts";
import { summarizeLoadoutRoles } from "@t3tools/shared/loadoutSummary";
import { useNavigate } from "@tanstack/react-router";
import { LayersIcon, SparklesIcon } from "lucide-react";
import { memo } from "react";

import { loadoutSettingsScopeSearch } from "../settings/loadoutEditor.logic";
import { searchableSetting } from "../settings/settingsSearch";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import type { ComposerLoadout } from "./useComposerLoadout";
import { useComposerMenuState } from "./useComposerMenuState";

const CLEAR_VALUE = "__clear__";
const EDIT_VALUE = "__edit__";

function loadoutTooltip(loadout: ComposerLoadout): string {
  if (loadout.choice?.setBy === "agent") {
    return `Proposed by the agent: ${loadout.choice.reason ?? "no reason given"}`;
  }
  return loadout.plannerKept ?? loadout.active.description;
}

/** A summary that does not name a planner the thread is not running on. */
function withoutPlanner(loadout: Loadout): Loadout {
  const { planner: _notRunning, ...roles } = loadout.roles;
  return { ...loadout, roles };
}

/**
 * Mounted only while the menu is open, so the sidebar project grouping it needs to name the
 * project scope is not subscribed to by every composer.
 */
function EditLoadoutsItem(props: { scope: ComposerLoadout["settingsScope"] }) {
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  const projectKey =
    groups.find((group) =>
      group.memberProjectRefs.some(
        (ref) =>
          ref.environmentId === props.scope.environmentId &&
          ref.projectId === props.scope.projectId,
      ),
    )?.projectKey ?? null;
  return (
    <SelectItem
      value={EDIT_VALUE}
      hideIndicator
      className="min-w-64"
      onClick={() =>
        void navigate({
          to: "/settings/threads",
          search: loadoutSettingsScopeSearch({
            environmentId: props.scope.environmentId,
            projectOverridden: props.scope.projectOverridden,
            projectKey,
          }),
          hash: searchableSetting("loadouts").id,
        })
      }
    >
      <span className="font-medium text-foreground">Edit loadouts…</span>
    </SelectItem>
  );
}

export const ComposerLoadoutPicker = memo(function ComposerLoadoutPicker(props: {
  loadout: ComposerLoadout;
  size?: "sm" | "xs";
  hidden?: boolean;
}) {
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const { loadout } = props;
  const agentProposed = loadout.choice?.setBy === "agent";

  return (
    <Tooltip>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={loadout.active.id}
        onValueChange={(value) => {
          if (value === CLEAR_VALUE) loadout.onClear();
          else if (value && value !== EDIT_VALUE) loadout.onSelect(value);
        }}
      >
        <TooltipTrigger render={<ComposerSelectControl size={size} aria-label="Loadout" />}>
          <ComposerControlIcon icon={LayersIcon} size={size} />
          <SelectValue data-composer-control-label>{loadout.active.name}</SelectValue>
          {agentProposed ? (
            <SparklesIcon className="size-3 shrink-0" aria-label="Proposed by the agent" />
          ) : null}
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
          {loadout.loadouts.map((option) => {
            const plannerKept = option.id === loadout.active.id ? loadout.plannerKept : null;
            return (
              <SelectItem key={option.id} value={option.id} hideIndicator className="min-w-64">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium text-foreground">
                    {option.name}
                    {agentProposed && option.id === loadout.active.id ? (
                      <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                        proposed by agent
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {summarizeLoadoutRoles(plannerKept === null ? option : withoutPlanner(option))}
                  </span>
                  {plannerKept === null ? null : (
                    <span className="max-w-72 text-warning-foreground text-xs leading-4">
                      {plannerKept}
                    </span>
                  )}
                </div>
              </SelectItem>
            );
          })}
          {loadout.choice?.setBy === "user" ? (
            <SelectItem value={CLEAR_VALUE} hideIndicator className="min-w-64">
              <div className="grid min-w-0 gap-0.5">
                <span className="font-medium text-foreground">Clear (let the agent propose)</span>
                <span className="text-muted-foreground text-xs leading-4">
                  Back to solo until the agent proposes one.
                </span>
              </div>
            </SelectItem>
          ) : null}
          <EditLoadoutsItem scope={loadout.settingsScope} />
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">{loadoutTooltip(loadout)}</TooltipPopup>
    </Tooltip>
  );
});
