import {
  type CommandId,
  type Ledger,
  type LedgerInvestigation,
  type LedgerItem,
  LedgerItemId,
  type ThreadId,
} from "@t3tools/contracts";
import { isApproachItem, isLiveApproach } from "@t3tools/shared/investigation";
import type * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { LedgerCommand, LedgerRejection, PlannedLedgerEvent } from "./TaskLedger.ts";

/**
 * Fork: Investigate mode's state machine, kept pure so every transition is tested without a
 * server. Approaches are sub-items of one Approaches item; the ledger's judge refutes each thesis
 * (a close request). The first passing verdict solves the investigation in the same transaction,
 * so no reactor can race it; budget and Stop end it through `ledger.investigation.end`.
 */

export type InvestigationCommand = Extract<
  LedgerCommand,
  { readonly type: "ledger.investigation.start" | "ledger.investigation.end" }
>;

export const isInvestigationCommand = (command: LedgerCommand): command is InvestigationCommand =>
  command.type === "ledger.investigation.start" || command.type === "ledger.investigation.end";

export const APPROACHES_ITEM_ID = LedgerItemId.make("approaches");
const LEDGER_TITLE_MAX = 120;

const isUnfinished = (item: Pick<LedgerItem, "status">) =>
  item.status === "open" || item.status === "in_progress";

function ledgerTitle(goal: string): string {
  const firstLine = goal.split("\n")[0]!.trim();
  const title = firstLine.length > 0 ? firstLine : "Investigation";
  return title.length > LEDGER_TITLE_MAX ? `${title.slice(0, LEDGER_TITLE_MAX - 1)}…` : title;
}

/** Drops the judge bookkeeping when the server sets an item aside. */
function settled(item: LedgerItem): LedgerItem {
  const { judging: _judging, judgeTaskId: _task, ...rest } = item;
  return rest;
}

type EndOutcome =
  | { readonly status: "solved"; readonly solvedItem: LedgerItem }
  | { readonly status: "exhausted" | "stopped"; readonly reason: string };

/**
 * Everything unfinished is dropped with the reason, the Approaches item is closed by the winner
 * (or dropped), and the ledger closes, so the between-turn follow-up has nothing left to push.
 */
function endEvents(
  ledger: Ledger,
  investigation: LedgerInvestigation,
  outcome: EndOutcome,
  now: DateTime.Utc,
): ReadonlyArray<PlannedLedgerEvent> {
  const reason =
    outcome.status === "solved"
      ? `Approach ${outcome.solvedItem.id} (${outcome.solvedItem.title}) survived the refuter.`
      : outcome.reason;
  const dropReason =
    outcome.status === "solved" ? `Not needed: ${reason}` : `Investigation ended: ${reason}`;
  const updates: Array<PlannedLedgerEvent> = [];
  for (const item of ledger.items) {
    if (item.id === investigation.approachesItemId) {
      const next: LedgerItem =
        outcome.status === "solved"
          ? {
              ...settled(item),
              status: "closed",
              evidence: reason,
              dropReason: null,
              closedAt: now,
              updatedAt: now,
            }
          : { ...settled(item), status: "dropped", dropReason, closedAt: null, updatedAt: now };
      if (item.status !== next.status) {
        updates.push({
          type: "ledger.item.updated",
          payload: { ledgerId: ledger.id, item: next, updatedAt: now },
        });
      }
      continue;
    }
    if (!isUnfinished(item)) continue;
    updates.push({
      type: "ledger.item.updated",
      payload: {
        ledgerId: ledger.id,
        item: { ...settled(item), status: "dropped", dropReason, closedAt: null, updatedAt: now },
        updatedAt: now,
      },
    });
  }
  return [
    ...updates,
    {
      type: "ledger.investigation.updated",
      payload: {
        ledgerId: ledger.id,
        investigation: {
          ...investigation,
          status: outcome.status,
          endedAt: now,
          endReason: reason,
          ...(outcome.status === "solved" ? { solvedItemId: outcome.solvedItem.id } : {}),
        },
        updatedAt: now,
      },
    },
    ...(ledger.closedAt === null
      ? [
          {
            type: "ledger.closed" as const,
            payload: { ledgerId: ledger.id, closedAt: now, updatedAt: now },
          },
        ]
      : []),
  ];
}

export function planInvestigationCommand(input: {
  readonly command: InvestigationCommand;
  readonly ledger: Ledger | undefined;
  readonly now: DateTime.Utc;
  readonly requiresJudge: boolean;
}): Result.Result<ReadonlyArray<PlannedLedgerEvent>, LedgerRejection> {
  const { command, ledger, now } = input;
  if (command.type === "ledger.investigation.start") {
    // A retried start finds its own ledger already running.
    if (ledger?.id === command.ledgerId && ledger.investigation !== undefined) {
      return Result.succeed([]);
    }
    if (ledger !== undefined && ledger.closedAt === null) {
      return Result.fail(
        `Thread ${command.threadId} already has an open ledger (${ledger.id}). Close it before starting an investigation.`,
      );
    }
    if (!input.requiresJudge) {
      return Result.fail(
        "Investigate needs a loadout with a judge role on an enabled provider, which refutes each approach's thesis. Pick one in the composer's loadout picker.",
      );
    }
    return Result.succeed([
      {
        type: "ledger.created",
        payload: {
          id: command.ledgerId,
          threadId: command.threadId,
          title: ledgerTitle(command.goal),
          startState: "",
          checkpoints: [],
          winConditions: [command.solvedWhen],
          items: [
            {
              id: APPROACHES_ITEM_ID,
              title: "Approaches",
              acceptance:
                "One approach's thesis survives the refuter, judged against the user's criteria.",
              status: "in_progress",
              evidence: null,
              dropReason: null,
              verdict: null,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
            },
          ],
          requiresJudge: true,
          investigation: {
            goal: command.goal,
            solvedWhen: command.solvedWhen,
            budget: command.budget,
            parallelApproaches: command.parallelApproaches,
            status: "running",
            approachesItemId: APPROACHES_ITEM_ID,
            startedAt: now,
            endedAt: null,
          },
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        },
      },
    ]);
  }
  if (ledger === undefined || ledger.id !== command.ledgerId) {
    return Result.fail(`Thread ${command.threadId} has no ledger ${command.ledgerId}.`);
  }
  const investigation = ledger.investigation;
  if (investigation === undefined) {
    return Result.fail(`Ledger ${ledger.id} is not an investigation.`);
  }
  // A deadline or Stop that lands after the investigation ended changes nothing.
  if (investigation.status !== "running") return Result.succeed([]);
  return Result.succeed(
    endEvents(ledger, investigation, { status: command.status, reason: command.reason }, now),
  );
}

/** Refuses approaches beyond the parallel limit: live approaches plus the new ones. */
export function investigationAddProblem(
  command: LedgerCommand,
  ledger: Ledger | undefined,
): string | undefined {
  const investigation = ledger?.investigation;
  if (command.type !== "ledger.item.add" || ledger === undefined || investigation === undefined) {
    return undefined;
  }
  const added = command.items.filter(
    (draft) =>
      draft.parentItemId === investigation.approachesItemId && draft.deferReason === undefined,
  ).length;
  if (added === 0) return undefined;
  if (investigation.status !== "running") {
    return `The investigation has ended (${investigation.status}); it takes no new approaches.`;
  }
  const live = ledger.items.filter(
    (item) => isApproachItem(investigation, item) && isLiveApproach(item),
  ).length;
  if (live + added > investigation.parallelApproaches) {
    return `The investigation runs at most ${investigation.parallelApproaches} approaches at once; ${live} are still being explored or judged. Add more once one is refuted.`;
  }
  return undefined;
}

/**
 * The events a command planned, plus the solve they cause: an approach item becoming closed can
 * only be a passing verdict (the ledger requires a judge), so it ends the investigation.
 */
export function followInvestigation(
  ledger: Ledger | undefined,
  planned: ReadonlyArray<PlannedLedgerEvent>,
  now: DateTime.Utc,
): ReadonlyArray<PlannedLedgerEvent> {
  const investigation = ledger?.investigation;
  if (ledger === undefined || investigation?.status !== "running") return planned;
  const solvedItem = planned.flatMap((event) =>
    event.type === "ledger.item.updated" &&
    event.payload.item.status === "closed" &&
    isApproachItem(investigation, event.payload.item) &&
    ledger.items.find(({ id }) => id === event.payload.item.id)?.status !== "closed"
      ? [event.payload.item]
      : [],
  )[0];
  if (solvedItem === undefined) return planned;
  // The end reads only items, so the planned item changes are all it needs folded in.
  const changed = new Map<string, LedgerItem>();
  for (const event of planned) {
    if (event.type === "ledger.item.updated")
      changed.set(event.payload.item.id, event.payload.item);
    if (event.type === "ledger.item.added") {
      for (const item of event.payload.items) changed.set(item.id, item);
    }
  }
  const after: Ledger = {
    ...ledger,
    items: [
      ...ledger.items.map((item) => changed.get(item.id) ?? item),
      ...[...changed.values()].filter((item) => !ledger.items.some(({ id }) => id === item.id)),
    ],
  };
  return [...planned, ...endEvents(after, investigation, { status: "solved", solvedItem }, now)];
}

/** Ending an investigation stops every delegated task under the thread, committed with the end. */
export function investigationEffects(
  command: { readonly commandId: CommandId; readonly threadId: ThreadId },
  planned: ReadonlyArray<PlannedLedgerEvent>,
): ReadonlyArray<PendingOrchestrationEffectV2> {
  const ended = planned.find(
    (event) =>
      event.type === "ledger.investigation.updated" &&
      event.payload.investigation.status !== "running",
  );
  if (ended?.type !== "ledger.investigation.updated") return [];
  return [
    {
      id: `effect:${command.commandId}:investigation-stop`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: {
        type: "delegated-tasks.stop",
        reason:
          `Investigation ${ended.payload.investigation.status}: ${ended.payload.investigation.endReason ?? ""}`.trim(),
      },
    },
  ];
}
