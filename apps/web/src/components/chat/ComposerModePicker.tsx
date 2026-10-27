/**
 * Fork: one Mode picker for Build, Plan and Investigate. It wraps upstream's plan toggle, so the
 * Shift+Tab shortcut, the /plan command and the proposed-plan card act on the same state.
 */
import type { EnvironmentId, ProviderInteractionMode, ThreadId } from "@t3tools/contracts";
import { BotIcon, FlaskConicalIcon, PencilRulerIcon } from "lucide-react";

import { MenuRadioGroup, MenuRadioItem, MenuSeparator } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { setInvestigating, useCanInvestigate, useInvestigating } from "./ComposerInvestigate";
import {
  type ComposerMode,
  type ComposerModeOption,
  composerModeChange,
  composerModeOption,
  composerModeOptions,
  resolveComposerMode,
} from "./composerMode.logic";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const MODE_ICONS = {
  build: BotIcon,
  plan: PencilRulerIcon,
  investigate: FlaskConicalIcon,
} satisfies Record<ComposerMode, unknown>;

export interface ComposerModeControl {
  readonly options: ReadonlyArray<ComposerModeOption>;
  readonly active: ComposerMode;
  readonly onSelect: (mode: ComposerMode) => void;
}

/** Null when Build is the only mode this composer has, as upstream shows no toggle then. */
export function useComposerMode(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly interactionMode: ProviderInteractionMode;
  readonly planAvailable: boolean;
  readonly toggleInteractionMode: () => void;
}): ComposerModeControl | null {
  const { environmentId, threadId, interactionMode, toggleInteractionMode } = input;
  const investigating = useInvestigating(environmentId, threadId);
  const investigateAvailable = useCanInvestigate(environmentId);
  const options = composerModeOptions({
    // A thread already in Plan keeps the option that names its mode.
    planAvailable: input.planAvailable || interactionMode === "plan",
    investigateAvailable,
  });
  if (options === null) return null;
  const state = { interactionMode, investigating };
  return {
    options,
    active: resolveComposerMode(state),
    onSelect: (mode) => {
      const change = composerModeChange(state, mode);
      if (change === null) return;
      setInvestigating(environmentId, threadId, change.investigating);
      if (change.toggleInteractionMode) toggleInteractionMode();
    },
  };
}

export function ComposerModePicker(props: {
  mode: ComposerModeControl;
  size: "sm" | "xs";
  hidden: boolean;
}) {
  const { mode, size } = props;
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const active = composerModeOption(mode.active);
  return (
    <Tooltip>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={mode.active}
        onValueChange={(value) => {
          if (value) mode.onSelect(value);
        }}
      >
        <TooltipTrigger render={<ComposerSelectControl size={size} aria-label="Mode" />}>
          <ComposerControlIcon icon={MODE_ICONS[mode.active]} size={size} />
          <SelectValue data-composer-control-label>{active.label}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
          {mode.options.map((option) => {
            const OptionIcon = MODE_ICONS[option.id];
            return (
              <SelectItem key={option.id} value={option.id} hideIndicator className="min-w-64">
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {option.label}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">{active.description}</TooltipPopup>
    </Tooltip>
  );
}

/** The same choice inside the overflow menu, when the mode block no longer fits the footer. */
export function ComposerModeMenuGroup(props: { mode: ComposerModeControl }) {
  const { mode } = props;
  return (
    <>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
      <MenuRadioGroup
        value={mode.active}
        onValueChange={(value) => {
          const option = mode.options.find(({ id }) => id === value);
          if (option) mode.onSelect(option.id);
        }}
      >
        {mode.options.map((option) => (
          <MenuRadioItem key={option.id} value={option.id}>
            {option.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
    </>
  );
}
