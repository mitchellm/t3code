import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const LoadoutId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type LoadoutId = typeof LoadoutId.Type;

export const LOADOUT_ROLE_NAMES = ["planner", "subPlanner", "explorer", "worker", "judge"] as const;
export const LoadoutRoleName = Schema.Literals(LOADOUT_ROLE_NAMES);
export type LoadoutRoleName = typeof LoadoutRoleName.Type;

/**
 * Where one role runs. `effort` is mapped onto whatever effort option the model advertises
 * when the role is resolved, so a loadout does not need to know each driver's option ids.
 */
const LoadoutRoleModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  effort: Schema.optionalKey(TrimmedNonEmptyString),
});

export const LoadoutRole = Schema.Struct({
  ...LoadoutRoleModel.fields,
  /**
   * Fork: what the role runs on when its own instance or model is missing or disabled. One level
   * only. Without it a role that cannot resolve degrades to the thread's own model, which for a
   * cross-vendor judge would put the judge back in the family it exists to check.
   */
  fallback: Schema.optionalKey(LoadoutRoleModel),
});
export type LoadoutRole = typeof LoadoutRole.Type;

/**
 * How work is split. `managers` keeps the top-level thread from editing or running shell
 * commands itself, so every change goes through a delegated role.
 */
export const LOADOUT_STRUCTURES = ["solo", "workers", "managers"] as const;
export const LoadoutStructure = Schema.Literals(LOADOUT_STRUCTURES);
export type LoadoutStructure = typeof LoadoutStructure.Type;

/** A named agent structure. A role that is absent runs on the thread's own model. */
export const Loadout = Schema.Struct({
  id: LoadoutId,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  roles: Schema.Struct({
    planner: Schema.optionalKey(LoadoutRole),
    subPlanner: Schema.optionalKey(LoadoutRole),
    explorer: Schema.optionalKey(LoadoutRole),
    worker: Schema.optionalKey(LoadoutRole),
    judge: Schema.optionalKey(LoadoutRole),
  }),
  /** Absent follows the roles: none is solo, any is workers. Only an explicit choice is managers. */
  structure: Schema.optionalKey(LoadoutStructure),
});
export type Loadout = typeof Loadout.Type;

export const LoadoutSetBy = Schema.Literals(["user", "agent"]);
export type LoadoutSetBy = typeof LoadoutSetBy.Type;

/**
 * The loadout a thread runs under and why. `setBy` is what lets an explicit user choice outrank
 * an agent's later proposal.
 */
export const ThreadLoadout = Schema.Struct({
  id: LoadoutId,
  reason: Schema.NullOr(Schema.String),
  setBy: LoadoutSetBy,
});
export type ThreadLoadout = typeof ThreadLoadout.Type;

const claude = (model: string, effort?: string): LoadoutRole => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model,
  ...(effort === undefined ? {} : { effort }),
});

export const SOLO_LOADOUT_ID: LoadoutId = "solo";

/**
 * Solo is the default for every thread: a solo strong model matched a full org on a four-module
 * task at a quarter of the cost, so escalating to roles has to be a deliberate choice.
 */
export const DEFAULT_LOADOUTS: ReadonlyArray<Loadout> = [
  {
    id: SOLO_LOADOUT_ID,
    name: "Solo",
    description: "One agent on the thread's own model. No delegated roles.",
    roles: {},
  },
  // Fork presets. Ids are the claudeAgent slugs in the model manifest; on an install without that
  // instance every role degrades to the thread's own model (see loadoutRoleTarget).
  {
    id: "opus-blowout",
    name: "Opus blowout",
    description: "Opus in every role. The most capable and the most expensive structure.",
    roles: {
      planner: claude("claude-opus-5-5", "xhigh"),
      subPlanner: claude("claude-opus-5-5", "high"),
      explorer: claude("claude-opus-5-5", "high"),
      worker: claude("claude-opus-5-5", "high"),
      judge: claude("claude-opus-5-5", "high"),
    },
  },
  {
    id: "blitz",
    name: "Blitz",
    description:
      "Opus plans, Sonnet implements and judges, Haiku reads. Balanced cost for big tasks.",
    roles: {
      planner: claude("claude-opus-5-5", "high"),
      explorer: claude("claude-haiku-5-5"),
      worker: claude("claude-sonnet-5-5"),
      judge: claude("claude-sonnet-5-5"),
    },
  },
  {
    id: "napalm",
    name: "Napalm",
    description: "Fast and cheap: Sonnet plans and works, Haiku explores and judges.",
    roles: {
      planner: claude("claude-sonnet-5-5"),
      explorer: claude("claude-haiku-5-5"),
      worker: claude("claude-sonnet-5-5"),
      judge: claude("claude-haiku-5-5"),
    },
  },
  {
    id: "haiku-workers",
    name: "Haiku workers",
    description:
      "Opus plans and judges carefully; Haiku at xhigh effort does the bulk of the implementing.",
    roles: {
      planner: claude("claude-opus-5-5", "xhigh"),
      worker: claude("claude-haiku-5-5", "xhigh"),
      judge: claude("claude-opus-5-5", "high"),
    },
  },
  {
    id: "cross-check",
    name: "Cross-check",
    description:
      "Opus plans, Sonnet implements, Haiku reads, and a GPT judge from another vendor passes each ledger item. A different family catches gaming that a Claude judge waves through; with no Codex the judge falls back to Opus.",
    roles: {
      planner: claude("claude-opus-5-5", "xhigh"),
      explorer: claude("claude-haiku-5-5"),
      worker: claude("claude-sonnet-5-5"),
      judge: {
        // The Codex default instance id is its driver kind (defaultInstanceIdForDriver).
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        effort: "high",
        fallback: claude("claude-opus-5-5", "high"),
      },
    },
  },
];
