import type { Ledger, LedgerInvestigation, LedgerItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Fork: Investigate mode's derived views, shared by the server (budget checks) and every client
 * (the run panel), so both read an approach and a budget the same way.
 */

/** Where one approach stands, read from its ledger item. */
export type ApproachLaneStatus = "exploring" | "judging" | "refuted" | "passed" | "dropped";

export interface ApproachLane {
  readonly item: LedgerItem;
  readonly status: ApproachLaneStatus;
}

function approachLaneStatus(item: LedgerItem): ApproachLaneStatus {
  if (item.status === "closed") return "passed";
  if (item.status === "dropped" || item.status === "deferred") return "dropped";
  if (item.judging === true) return "judging";
  // A failing verdict hands the item back in progress with the refutation as its notes.
  if (item.verdict?.outcome === "fail") return "refuted";
  return "exploring";
}

export const isApproachItem = (investigation: LedgerInvestigation, item: LedgerItem) =>
  item.parentItemId === investigation.approachesItemId;

export function investigationLanes(ledger: Ledger): ReadonlyArray<ApproachLane> {
  const investigation = ledger.investigation;
  if (investigation === undefined) return [];
  return ledger.items
    .filter((item) => isApproachItem(investigation, item))
    .map((item) => ({ item, status: approachLaneStatus(item) }));
}

/**
 * Approaches that still hold a slot under the parallel cap: every open or in-progress one,
 * refuted ones included. A refuted approach frees its slot only when it is dropped.
 */
export const isLiveApproach = (item: LedgerItem) =>
  item.status === "open" || item.status === "in_progress";

/** Handed back by the refuter and not judging again: the agent may drop it, claiming nothing. */
export const isRefutedApproach = (investigation: LedgerInvestigation, item: LedgerItem) =>
  isApproachItem(investigation, item) && approachLaneStatus(item) === "refuted";

export const investigationDeadlineMs = (investigation: LedgerInvestigation): number | null =>
  investigation.budget.minutes === undefined
    ? null
    : DateTime.toEpochMillis(investigation.startedAt) + investigation.budget.minutes * 60_000;

export interface InvestigationBudgetUse {
  readonly elapsedMs: number;
  readonly limitMs: number | null;
  readonly spentUsd: number;
  readonly limitUsd: number | null;
  /** The larger share used of either limit, 0 to 1, for one bar. */
  readonly fraction: number;
  /** Which limit is used up, time first; null while both have room. */
  readonly exhausted: "time" | "usd" | null;
}

/** An ended investigation's clock stops at its end. */
export function investigationBudgetUse(input: {
  readonly investigation: LedgerInvestigation;
  readonly nowMs: number;
  readonly spentUsd: number;
}): InvestigationBudgetUse {
  const { investigation } = input;
  const startMs = DateTime.toEpochMillis(investigation.startedAt);
  const endMs =
    investigation.endedAt === null ? input.nowMs : DateTime.toEpochMillis(investigation.endedAt);
  const elapsedMs = Math.max(0, endMs - startMs);
  const limitMs =
    investigation.budget.minutes === undefined ? null : investigation.budget.minutes * 60_000;
  const limitUsd = investigation.budget.usd ?? null;
  const timeShare = limitMs === null ? 0 : elapsedMs / limitMs;
  const usdShare = limitUsd === null ? 0 : input.spentUsd / limitUsd;
  return {
    elapsedMs,
    limitMs,
    spentUsd: input.spentUsd,
    limitUsd,
    fraction: Math.min(1, Math.max(timeShare, usdShare)),
    exhausted:
      limitMs !== null && elapsedMs >= limitMs
        ? "time"
        : limitUsd !== null && input.spentUsd >= limitUsd
          ? "usd"
          : null,
  };
}

export function formatInvestigationBudget(
  investigation: Pick<LedgerInvestigation, "budget">,
): string {
  const parts = [
    ...(investigation.budget.minutes === undefined ? [] : [`${investigation.budget.minutes} min`]),
    ...(investigation.budget.usd === undefined ? [] : [`$${investigation.budget.usd.toFixed(2)}`]),
  ];
  return parts.join(" or ");
}
