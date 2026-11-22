import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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
 * task at a quarter of the cost, so escalating to roles has to be a deliberate choice. It is also
 * what a thread runs under when the saved list no longer holds it, so it is not stored only in the
 * list below.
 */
export const SOLO_LOADOUT: Loadout = {
  id: SOLO_LOADOUT_ID,
  name: "Solo",
  description:
    "One agent on the thread's own model. No delegated roles. On single fixes of up to 40 minutes this did as well as a planner with workers and a judge, at half the cost.",
  roles: {},
};

export const DEFAULT_LOADOUTS: ReadonlyArray<Loadout> = [
  SOLO_LOADOUT,
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
      "Opus plans, Sonnet implements and judges, Haiku reads. Balanced cost for big tasks. Not for a single fix: measured on 5 to 40 minute fixes, a strong planner and judge with Sonnet workers did no better than the strong model alone.",
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
  {
    id: "checked-solo",
    name: "Checked solo",
    description:
      "One agent builds on the thread's model; Opus checks the finished work against your message, up to three times, then stops and reports. Measured on hard fixes: a Sonnet builder got 21 of 30 right first time against 13 of 30 unchecked, at 2.4 times the cost; an Opus builder 26 of 30 against 19 of 30, at 1.6 times the cost, with the earlier uncapped check. On small tasks it only adds cost.",
    structure: "solo",
    roles: { judge: claude("claude-opus-5-5", "high") },
  },
];

/** Presets the fork once shipped, exactly as shipped, so a saved list can be told apart from them. */
const RETIRED_LOADOUTS: ReadonlyArray<Loadout> = [
  {
    id: "planner-workers-judge",
    name: "Planner + workers + judge",
    description:
      "A strong planner splits the task, cheaper workers implement, and a separate judge must pass each ledger item before it closes.",
    roles: {
      planner: claude("claude-opus-5-5", "xhigh"),
      worker: claude("claude-sonnet-5-5"),
      judge: claude("claude-opus-5-5", "high"),
    },
  },
  {
    id: "read-only-sweep",
    name: "Read-only sweep",
    description: "Cheap explorers read and report across the codebase. Nothing is implemented.",
    roles: { explorer: claude("claude-haiku-5-5") },
  },
];

/**
 * Presets that still ship under an earlier description, exactly as shipped. A saved copy of one is
 * swapped for the current preset as it is read; the description is the only thing that changed.
 */
const EARLIER_PRESETS: ReadonlyArray<Loadout> = [
  {
    id: SOLO_LOADOUT_ID,
    name: "Solo",
    description: "One agent on the thread's own model. No delegated roles.",
    roles: {},
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
    id: "checked-solo",
    name: "Checked solo",
    description:
      "One agent builds on the thread's model; Opus checks the finished work against your message.",
    structure: "solo",
    roles: { judge: claude("claude-opus-5-5", "high") },
  },
  {
    id: "checked-solo",
    name: "Checked solo",
    description:
      "One agent builds on the thread's model; Opus checks the finished work against your message. Measured with a Sonnet builder on hard fixes: 20 of 25 right first time against 7 of 25 unchecked, at about 3 times the cost. On small tasks it only adds cost.",
    structure: "solo",
    roles: { judge: claude("claude-opus-5-5", "high") },
  },
];

const sameLoadout = Schema.toEquivalence(Loadout);

/**
 * Fork: a stored loadout list. Saving replaces the list whole, so anyone who saved once froze a
 * copy of every preset of that day. An untouched copy of a since-retired preset is dropped as it
 * is read, and an untouched copy of an earlier description of a preset that still ships becomes
 * the current preset in place; any edit makes a copy the user's own, and it stays.
 */
export const SavedLoadouts = Schema.Array(Loadout).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.toType(Loadout)),
    SchemaTransformation.transform<ReadonlyArray<Loadout>, ReadonlyArray<Loadout>>({
      decode: (loadouts) =>
        loadouts.flatMap((loadout) => {
          if (RETIRED_LOADOUTS.some((old) => sameLoadout(old, loadout))) return [];
          const upgraded = EARLIER_PRESETS.some((old) => sameLoadout(old, loadout))
            ? DEFAULT_LOADOUTS.find(({ id }) => id === loadout.id)
            : undefined;
          return [upgraded ?? loadout];
        }),
      encode: (loadouts) => loadouts,
    }),
  ),
);
