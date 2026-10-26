import * as Schema from "effect/Schema";

import {
  CommandId,
  LedgerId,
  LedgerItemId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Fork: Investigate mode. An investigation is a thread whose ledger carries this record: parallel
 * approaches are sub-items of one "Approaches" item, each thesis is refuted by the ledger's judge,
 * and the first that survives solves it. The record rides the ledger document, so it persists,
 * replays and reaches clients exactly as the ledger does.
 */

export const INVESTIGATION_MIN_PARALLEL_APPROACHES = 1;
export const INVESTIGATION_MAX_PARALLEL_APPROACHES = 8;
export const INVESTIGATION_DEFAULT_PARALLEL_APPROACHES = 4;
/** Criteria are pinned verbatim, so they must fit one pin with room for the label. */
export const INVESTIGATION_SOLVED_WHEN_MAX_LENGTH = 4_000;
export const INVESTIGATION_GOAL_MAX_LENGTH = 8_000;

export const InvestigationStatus = Schema.Literals(["running", "solved", "exhausted", "stopped"]);
export type InvestigationStatus = typeof InvestigationStatus.Type;

const PositiveUsd = Schema.Number.check(Schema.isGreaterThan(0), Schema.isFinite());

/** Wall-clock minutes, dollars, or both; whichever runs out first ends the investigation. */
export const InvestigationBudget = Schema.Struct({
  minutes: Schema.optionalKey(PositiveInt),
  usd: Schema.optionalKey(PositiveUsd),
}).check(
  Schema.makeFilter(
    (budget) =>
      budget.minutes !== undefined ||
      budget.usd !== undefined ||
      "An investigation budget needs minutes, dollars, or both.",
  ),
);
export type InvestigationBudget = typeof InvestigationBudget.Type;

export const InvestigationParallelApproaches = Schema.Int.check(
  Schema.isBetween({
    minimum: INVESTIGATION_MIN_PARALLEL_APPROACHES,
    maximum: INVESTIGATION_MAX_PARALLEL_APPROACHES,
  }),
);

export const InvestigationGoal = TrimmedNonEmptyString.check(
  Schema.isMaxLength(INVESTIGATION_GOAL_MAX_LENGTH),
);
export const InvestigationSolvedWhen = TrimmedNonEmptyString.check(
  Schema.isMaxLength(INVESTIGATION_SOLVED_WHEN_MAX_LENGTH),
);

export const LedgerInvestigation = Schema.Struct({
  goal: InvestigationGoal,
  /** The user's criteria, verbatim; the refuter judges every thesis against them. */
  solvedWhen: InvestigationSolvedWhen,
  budget: InvestigationBudget,
  parallelApproaches: InvestigationParallelApproaches,
  status: InvestigationStatus,
  /** The ledger item every approach sits under. */
  approachesItemId: LedgerItemId,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The approach whose thesis survived the refuter; present only when solved. */
  solvedItemId: Schema.optionalKey(LedgerItemId),
  /** Why it ended, in a sentence for the run view. */
  endReason: Schema.optionalKey(Schema.String),
});
export type LedgerInvestigation = typeof LedgerInvestigation.Type;

export const LedgerInvestigationJson = LedgerInvestigation.mapFields((fields) => ({
  ...fields,
  startedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

/** Server-only: creates the thread's ledger with its investigation and the Approaches item. */
export const LedgerInvestigationStartCommand = Schema.Struct({
  type: Schema.Literal("ledger.investigation.start"),
  commandId: CommandId,
  threadId: ThreadId,
  ledgerId: LedgerId,
  goal: InvestigationGoal,
  solvedWhen: InvestigationSolvedWhen,
  budget: InvestigationBudget,
  parallelApproaches: InvestigationParallelApproaches,
});

/**
 * Server-only: ends a running investigation without a winner. Solving is not a command: it is
 * decided in the same transaction as the passing verdict that closes an approach.
 */
export const LedgerInvestigationEndCommand = Schema.Struct({
  type: Schema.Literal("ledger.investigation.end"),
  commandId: CommandId,
  threadId: ThreadId,
  ledgerId: LedgerId,
  status: Schema.Literals(["exhausted", "stopped"]),
  reason: TrimmedNonEmptyString,
});

export const LedgerInvestigationUpdatedPayload = Schema.Struct({
  ledgerId: LedgerId,
  investigation: LedgerInvestigation,
  updatedAt: Schema.DateTimeUtc,
});
export type LedgerInvestigationUpdatedPayload = typeof LedgerInvestigationUpdatedPayload.Type;

export const LedgerInvestigationUpdatedPayloadJson = LedgerInvestigationUpdatedPayload.mapFields(
  (fields) => ({
    ...fields,
    investigation: LedgerInvestigationJson,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

export const OrchestrationStartInvestigationInput = Schema.Struct({
  threadId: ThreadId,
  /** Chosen by the client, so a retried start is the same investigation, not a second one. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  goal: InvestigationGoal,
  solvedWhen: InvestigationSolvedWhen,
  budget: InvestigationBudget,
  parallelApproaches: InvestigationParallelApproaches,
  modelSelection: Schema.optional(ModelSelection),
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
});
export type OrchestrationStartInvestigationInput = typeof OrchestrationStartInvestigationInput.Type;

export const OrchestrationStartInvestigationResult = Schema.Struct({
  threadId: ThreadId,
  ledgerId: LedgerId,
});
export type OrchestrationStartInvestigationResult =
  typeof OrchestrationStartInvestigationResult.Type;

export const OrchestrationStopInvestigationInput = Schema.Struct({ threadId: ThreadId });
export type OrchestrationStopInvestigationInput = typeof OrchestrationStopInvestigationInput.Type;

export class OrchestrationInvestigationError extends Schema.TaggedError<OrchestrationInvestigationError>()(
  "OrchestrationInvestigationError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
