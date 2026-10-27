import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type Loadout,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadLoadout,
} from "@t3tools/contracts";
import { resolveLoadout, withSolo } from "@t3tools/shared/loadouts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject, useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { toastManager } from "../ui/toast";
import {
  draftLaunchLoadout,
  pickLoadout,
  setDraftLoadoutChoice,
  shownLoadoutChoice,
  useDraftLoadoutChoice,
} from "./draftLoadout";
import {
  applyPlannerModelSwitch,
  loadoutAsRun,
  type PlannerComposer,
  type PlannerPicker,
  plannerModelSwitch,
  plannerRun,
} from "./loadoutPlanner";

/**
 * Fork: the composer's model picker, for moving a user's pick onto its loadout's planner, which is
 * the top-level thread itself. Without it a pick changes the loadout only.
 */
export interface ComposerLoadoutPlanner {
  /** What the picker offers and what the next send uses, a new chat's fan-out included. */
  readonly picker: PlannerPicker;
  readonly composer: PlannerComposer;
}

export interface ComposerLoadout {
  readonly loadouts: ReadonlyArray<Loadout>;
  /** The loadout the thread runs under; solo when none was chosen or it was since deleted. */
  readonly active: Loadout;
  /** `active` as it runs, for its summary: its planner swapped for the fallback, or dropped. */
  readonly activeAsRun: Loadout;
  /** Why the composer is not on the active loadout's planner; null when it is or there is none. */
  readonly plannerNotRunning: string | null;
  readonly choice: ThreadLoadout | null;
  /** Which settings scope defines the list: the project's own override, else the environment's. */
  readonly settingsScope: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly projectOverridden: boolean;
  };
  readonly onSelect: (loadoutId: string) => void;
  readonly onClear: () => void;
}

function useProjectLoadouts(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const project = useProject(projectId === null ? null : scopeProjectRef(environmentId, projectId));
  const settings = useEnvironmentSettings(environmentId);
  if (projectId === null) return null;
  return {
    loadouts: withSolo(
      resolveProjectSettings(settings, projectId, project ?? undefined).settings.loadouts,
    ),
    projectOverridden: settings.projectSettingsOverrides?.[projectId]?.loadouts !== undefined,
  };
}

const useDraftProjectId = (draftId: DraftId | null) =>
  useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.projectId ?? null),
  );

/**
 * A thread's loadout and the list its project resolves to. A draft has no thread yet, so it holds
 * its own pick until the first send creates the thread under it; once that thread exists, its own
 * loadout is what runs and what this shows. `draft.sending` keeps the pick shown while the send
 * creates the thread and then sets its loadout.
 */
export function useComposerLoadout(
  environmentId: EnvironmentId,
  threadRef: ScopedThreadRef | null,
  draft: { readonly draftId: DraftId; readonly sending: boolean } | null,
  planner?: ComposerLoadoutPlanner,
): ComposerLoadout | null {
  const shell = useThreadShell(threadRef);
  const draftId = draft?.draftId ?? null;
  const draftProjectId = useDraftProjectId(shell === null ? draftId : null);
  const draftChoice = useDraftLoadoutChoice(draftId);
  const projectId = shell?.projectId ?? draftProjectId;
  const scope = useProjectLoadouts(environmentId, projectId);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: true,
  });
  if (scope === null || projectId === null) return null;
  const choice = shownLoadoutChoice({ shell, draftChoice, sending: draft?.sending === true });
  const setChoice = (next: ThreadLoadout | null) => {
    if (shell !== null) {
      void updateMetadata({ environmentId, input: { threadId: shell.id, loadout: next } });
    } else if (draftId !== null) {
      setDraftLoadoutChoice(draftId, next);
    }
  };
  const active = resolveLoadout(scope.loadouts, choice?.id);
  const run =
    planner === undefined
      ? ({ _tag: "unknown" } as const)
      : plannerRun({ loadout: active, picker: planner.picker });
  return {
    loadouts: scope.loadouts,
    active,
    activeAsRun: loadoutAsRun(active, run),
    plannerNotRunning: run._tag === "notRunning" ? run.reason : null,
    choice,
    settingsScope: { environmentId, projectId, projectOverridden: scope.projectOverridden },
    // Hands the slot back so the agent may propose again; a user pick otherwise stands for good.
    onClear: () => {
      if (choice !== null) setChoice(null);
    },
    onSelect: (loadoutId) => {
      const next = pickLoadout(choice, loadoutId);
      if (next !== choice) setChoice(next);
      // Re-picking what already runs applies too, so a pick brings back a model changed since.
      if (planner === undefined) return;
      const decision = plannerModelSwitch({
        pick: next,
        loadout: resolveLoadout(scope.loadouts, loadoutId),
        picker: planner.picker,
      });
      const notApplied = applyPlannerModelSwitch(decision, planner.composer);
      if (notApplied !== null) {
        toastManager.add({
          type: "warning",
          title: "Planner not applied",
          description: notApplied,
        });
      }
    },
  };
}

/** The loadout a draft's first send creates its thread with, resolved against today's list. */
export function useDraftLaunchLoadout(environmentId: EnvironmentId, draftId: DraftId | null) {
  const projectId = useDraftProjectId(draftId);
  const choice = useDraftLoadoutChoice(draftId);
  const scope = useProjectLoadouts(environmentId, projectId);
  return draftLaunchLoadout(choice, scope?.loadouts ?? withSolo([]));
}
