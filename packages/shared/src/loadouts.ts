import {
  LOADOUT_ROLE_NAMES,
  type Loadout,
  type LoadoutRole,
  type LoadoutRoleName,
  type LoadoutStructure,
  type OrchestratorMcpTarget,
  type ProviderOptionSelection,
  SOLO_LOADOUT_ID,
  type ThreadLoadout,
} from "@t3tools/contracts";

/** What a thread runs under when its loadout is unset or no longer in the saved list. */
const SOLO: Loadout = {
  id: SOLO_LOADOUT_ID,
  name: "Solo",
  description: "One agent on the thread's own model. No delegated roles.",
  roles: {},
};

/**
 * The list a person can pick from. Solo is the way back to "no delegated roles", so it stays
 * available even if the saved list dropped it.
 */
export function withSolo(loadouts: ReadonlyArray<Loadout>): ReadonlyArray<Loadout> {
  return loadouts.some(({ id }) => id === SOLO_LOADOUT_ID) ? loadouts : [SOLO, ...loadouts];
}

/**
 * Finds a thread's loadout in the list its project resolves to. An unknown id means the loadout
 * was deleted after the thread chose it; the thread keeps working solo rather than failing.
 */
export function resolveLoadout(
  loadouts: ReadonlyArray<Loadout>,
  loadoutId: string | null | undefined,
): Loadout {
  const wanted = loadoutId ?? SOLO_LOADOUT_ID;
  return loadouts.find(({ id }) => id === wanted) ?? SOLO;
}

export const loadoutHasJudge = (loadout: Loadout): boolean => loadout.roles.judge !== undefined;

export const loadoutStructure = (loadout: Loadout): LoadoutStructure =>
  loadout.structure ?? (Object.keys(loadout.roles).length === 0 ? "solo" : "workers");

export type ThreadLoadoutDecision =
  | { readonly _tag: "set"; readonly loadout: ThreadLoadout | null }
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "user_choice_stands" };

/**
 * The one precedence rule: the user's explicit choice outranks any agent proposal. The user can
 * always replace or clear whatever stands; an agent can only fill an empty slot or update its
 * own earlier proposal. Reasons are part of identity so a changed reason is still recorded.
 */
export function decideThreadLoadout(
  current: ThreadLoadout | null | undefined,
  requested: ThreadLoadout | null,
): ThreadLoadoutDecision {
  if (requested === null) {
    return current === null || current === undefined
      ? { _tag: "unchanged" }
      : { _tag: "set", loadout: null };
  }
  if (requested.setBy === "agent" && current?.setBy === "user") {
    return { _tag: "user_choice_stands" };
  }
  if (
    current !== null &&
    current !== undefined &&
    current.id === requested.id &&
    current.setBy === requested.setBy &&
    current.reason === requested.reason
  ) {
    return { _tag: "unchanged" };
  }
  return { _tag: "set", loadout: requested };
}

/** The slice of a provider snapshot needed to turn a role into a delegation target. */
export interface LoadoutProviderView {
  readonly instanceId: string;
  readonly enabled?: boolean | undefined;
  /**
   * False when the CLI is absent. Such a provider is still registered and enabled but lists no
   * models, which `loadoutRoleTarget` would otherwise read as "cannot enumerate, trust the role".
   */
  readonly installed?: boolean | undefined;
  readonly availability?: "available" | "unavailable" | undefined;
  readonly models: ReadonlyArray<{
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
  }>;
}

const isLoadoutRoleName = (role: string): role is LoadoutRoleName =>
  (LOADOUT_ROLE_NAMES as ReadonlyArray<string>).includes(role);

/**
 * The target `delegate_task` should use for a named role under a loadout. Undefined means "use
 * the thread's own model": the name is not a loadout role, the loadout leaves it unassigned (solo
 * leaves all of them), or the role's instance or model is gone.
 */
export function loadoutDelegationTarget(
  loadout: Loadout,
  role: string | undefined,
  providers: ReadonlyArray<LoadoutProviderView>,
): OrchestratorMcpTarget | undefined {
  if (role === undefined || !isLoadoutRoleName(role)) return undefined;
  const assigned = loadout.roles[role];
  return assigned === undefined ? undefined : loadoutRoleTarget(assigned, providers);
}

export function providerUnusable(
  provider: LoadoutProviderView,
): "disabled_instance" | "not_installed" | null {
  if (provider.enabled === false) return "disabled_instance";
  return provider.installed === false || provider.availability === "unavailable"
    ? "not_installed"
    : null;
}

/** The role's own model then its fallback, as plain targets, with no live provider state. */
export function loadoutRoleCandidates(role: LoadoutRole): ReadonlyArray<{
  readonly providerInstanceId: LoadoutRole["instanceId"];
  readonly model: string;
}> {
  return [role, ...(role.fallback === undefined ? [] : [role.fallback])].map((candidate) => ({
    providerInstanceId: candidate.instanceId,
    model: candidate.model,
  }));
}

/**
 * The candidate a recorded run matches. Judging compares against what actually started, not a
 * fresh resolution: a slow probe can make the primary resolvable after the judge began on the
 * fallback, and that judge is still the right one.
 */
export function matchRoleCandidate(
  role: LoadoutRole,
  ran: { readonly instanceId: string; readonly model: string },
) {
  return loadoutRoleCandidates(role).find(
    ({ providerInstanceId, model }) => providerInstanceId === ran.instanceId && model === ran.model,
  );
}

/**
 * Whether new ledgers must be judged. `canRun` is registration and project enablement only, never
 * install state: before the first provider probe every snapshot reads "not installed", and
 * stamping false then would switch judging off for that ledger permanently.
 */
export function loadoutRequiresJudge(
  loadout: Loadout,
  canRun: (instanceId: LoadoutRole["instanceId"]) => boolean,
): boolean {
  const judge = loadout.roles.judge;
  return (
    judge !== undefined && loadoutRoleCandidates(judge).some((c) => canRun(c.providerInstanceId))
  );
}

// Drivers name their effort option differently (Claude "effort", Codex "reasoningEffort").
export const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["effort", "reasoningEffort"]);

/**
 * Turns a role into a delegation target against the live provider list. Returns undefined when
 * the instance is gone or does not offer the model, so callers decide how to degrade. An effort
 * the model does not offer is dropped, not an error: the role still runs, at the model default.
 */
export function loadoutRoleTarget(
  role: LoadoutRole,
  providers: ReadonlyArray<LoadoutProviderView>,
): OrchestratorMcpTarget | undefined {
  const { fallback, ...own } = role;
  return (
    modelTarget(own, providers) ??
    (fallback === undefined ? undefined : modelTarget(fallback, providers))
  );
}

function modelTarget(
  role: Omit<LoadoutRole, "fallback">,
  providers: ReadonlyArray<LoadoutProviderView>,
): OrchestratorMcpTarget | undefined {
  const provider = providers.find(({ instanceId }) => instanceId === role.instanceId);
  // Fork: a disabled or uninstalled instance cannot run, so it counts as gone and the fallback applies.
  if (provider === undefined || providerUnusable(provider) !== null) return undefined;
  const model = provider.models.find(({ slug }) => slug === role.model);
  // An empty list means the provider cannot enumerate models, so the role's model is trusted.
  if (model === undefined && provider.models.length > 0) return undefined;
  const options = roleEffortOptions(model, role.effort);
  return {
    providerInstanceId: role.instanceId,
    model: role.model,
    ...(options.length === 0 ? {} : { options }),
  };
}

/** The model's own effort option set to `effort`; none when the model does not offer that level. */
export function roleEffortOptions(
  model: LoadoutProviderView["models"][number] | undefined,
  effort: string | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const effortOption = model?.capabilities?.optionDescriptors?.find(
    (descriptor) =>
      EFFORT_OPTION_IDS.has(descriptor.id) &&
      descriptor.type === "select" &&
      descriptor.options?.some(({ id }) => id === effort) === true,
  );
  return effortOption === undefined || effort === undefined
    ? []
    : [{ id: effortOption.id, value: effort }];
}

export interface JudgeVerdictText {
  readonly outcome: "pass" | "fail";
  readonly notes: string;
}

const VERDICT_LINE = /^\s*[*_`>#-]*\s*verdict\s*[*_`]*\s*:\s*[*_`]*\s*(pass|fail)\b/iu;
const MAX_NOTES_LENGTH = 4_000;

/**
 * Reads a judge's final answer. Only the last non-empty line counts, and only as
 * `VERDICT: PASS` or `VERDICT: FAIL`: the judge is shown the agent's evidence, which may quote
 * such a line, so a verdict anywhere else in the answer is not trusted. No such line is no verdict.
 */
export function parseJudgeVerdict(answer: string | null | undefined): JudgeVerdictText | null {
  if (answer === null || answer === undefined) return null;
  const lines = answer.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const match = VERDICT_LINE.exec(lines.at(-1) ?? "");
  if (match?.[1] === undefined) return null;
  return {
    outcome: match[1].toLowerCase() === "pass" ? "pass" : "fail",
    notes: answer.trim().slice(0, MAX_NOTES_LENGTH),
  };
}
