// Fork: describing and validating loadouts for the editor and composer picker. Kept apart from
// loadouts.ts so upstream syncs do not touch it.
import {
  LOADOUT_ROLE_NAMES,
  type Loadout,
  type LoadoutRole,
  type LoadoutRoleName,
} from "@t3tools/contracts";

import type { LoadoutProviderView } from "./loadouts.ts";

const ROLE_VERBS: Record<LoadoutRoleName, string> = {
  planner: "plans",
  subPlanner: "sub-plans",
  explorer: "explores",
  worker: "works",
  judge: "judges",
};

const CLAUDE_FAMILY = /\b(opus|sonnet|haiku|fable)\b/iu;

/** "claude-opus-5-5" reads as "Opus"; a model that is not a Claude family shows its slug. */
export function loadoutModelShortName(model: string): string {
  const family = CLAUDE_FAMILY.exec(model)?.[1];
  return family === undefined
    ? model
    : `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}`;
}

const roleSegment = (name: LoadoutRoleName, role: LoadoutRole): string =>
  [loadoutModelShortName(role.model), role.effort, ROLE_VERBS[name]]
    .filter((part) => part !== undefined)
    .join(" ");

/** One line saying which model does which job, e.g. "Opus xhigh plans · Haiku works". */
export function summarizeLoadoutRoles(loadout: Loadout): string {
  const segments = LOADOUT_ROLE_NAMES.flatMap((name) => {
    const role = loadout.roles[name];
    return role === undefined ? [] : [roleSegment(name, role)];
  });
  return segments.length === 0 ? "No delegated roles" : segments.join(" · ");
}

export type LoadoutRoleIssueKind = "missing_instance" | "disabled_instance" | "missing_model";

export interface LoadoutRoleIssue {
  readonly role: LoadoutRoleName;
  readonly issue: LoadoutRoleIssueKind;
}

/**
 * Why a role would not resolve against the live provider list. A provider that lists no models
 * cannot enumerate them, so its roles' models are trusted, matching `loadoutRoleTarget`.
 */
export function loadoutRoleIssue(
  role: LoadoutRole,
  providers: ReadonlyArray<LoadoutProviderView & { readonly enabled?: boolean }>,
): LoadoutRoleIssueKind | null {
  const provider = providers.find(({ instanceId }) => instanceId === role.instanceId);
  if (provider === undefined) return "missing_instance";
  if (provider.enabled === false) return "disabled_instance";
  if (provider.models.length > 0 && !provider.models.some(({ slug }) => slug === role.model)) {
    return "missing_model";
  }
  return null;
}

export function loadoutRoleIssues(
  loadout: Loadout,
  providers: ReadonlyArray<LoadoutProviderView & { readonly enabled?: boolean }>,
): ReadonlyArray<LoadoutRoleIssue> {
  return LOADOUT_ROLE_NAMES.flatMap((name) => {
    const role = loadout.roles[name];
    if (role === undefined) return [];
    const issue = loadoutRoleIssue(role, providers);
    return issue === null ? [] : [{ role: name, issue }];
  });
}
