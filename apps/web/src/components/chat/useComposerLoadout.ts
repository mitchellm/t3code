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
import {
  draftLaunchLoadout,
  pickLoadout,
  setDraftLoadoutChoice,
  useDraftLoadoutChoice,
} from "./draftLoadout";

export interface ComposerLoadout {
  readonly loadouts: ReadonlyArray<Loadout>;
  /** The loadout the thread runs under; solo when none was chosen or it was since deleted. */
  readonly active: Loadout;
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
 * loadout is what runs and what this shows.
 */
export function useComposerLoadout(
  environmentId: EnvironmentId,
  threadRef: ScopedThreadRef | null,
  draftId: DraftId | null,
): ComposerLoadout | null {
  const shell = useThreadShell(threadRef);
  const draftTarget = shell === null ? draftId : null;
  const draftProjectId = useDraftProjectId(draftTarget);
  const draftChoice = useDraftLoadoutChoice(draftTarget);
  const projectId = shell?.projectId ?? draftProjectId;
  const scope = useProjectLoadouts(environmentId, projectId);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: true,
  });
  if (scope === null || projectId === null) return null;
  const choice = shell === null ? draftChoice : (shell.loadout ?? null);
  const setChoice = (next: ThreadLoadout | null) => {
    if (shell !== null) {
      void updateMetadata({ environmentId, input: { threadId: shell.id, loadout: next } });
    } else if (draftTarget !== null) {
      setDraftLoadoutChoice(draftTarget, next);
    }
  };
  return {
    loadouts: scope.loadouts,
    active: resolveLoadout(scope.loadouts, choice?.id),
    choice,
    settingsScope: { environmentId, projectId, projectOverridden: scope.projectOverridden },
    // Hands the slot back so the agent may propose again; a user pick otherwise stands for good.
    onClear: () => {
      if (choice !== null) setChoice(null);
    },
    onSelect: (loadoutId) => {
      const next = pickLoadout(choice, loadoutId);
      if (next !== choice) setChoice(next);
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
