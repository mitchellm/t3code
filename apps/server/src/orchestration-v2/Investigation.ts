import {
  type CommandId,
  isOrchestrationV2WorkActive,
  type Ledger,
  type LedgerInvestigation,
  type LedgerItem,
  LedgerItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { isApproachItem, isLiveApproach } from "@t3tools/shared/investigation";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
  {
    readonly type:
      | "ledger.investigation.start"
      | "ledger.investigation.end"
      | "ledger.investigation.spend";
  }
>;

export const isInvestigationCommand = (command: LedgerCommand): command is InvestigationCommand =>
  command.type === "ledger.investigation.start" ||
  command.type === "ledger.investigation.end" ||
  command.type === "ledger.investigation.spend";

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
  // A deadline, Stop or spend report that lands after the investigation ended changes nothing.
  if (investigation.status !== "running") return Result.succeed([]);
  if (command.type === "ledger.investigation.spend") {
    return Result.succeed(planInvestigationSpend(ledger, command, now));
  }
  return Result.succeed(
    endEvents(ledger, investigation, { status: command.status, reason: command.reason }, now),
  );
}

/**
 * What the investigation refuses on top of the ledger's own rules. Approaches never move in or out
 * of the Approaches item: a moved item could carry a verdict from the ordinary judge, or free or
 * take a slot past the parallel limit. New and revived approaches must fit the limit.
 */
export function investigationCommandProblem(
  command: LedgerCommand,
  ledger: Ledger | undefined,
): string | undefined {
  const investigation = ledger?.investigation;
  if (ledger === undefined || investigation === undefined) return undefined;
  const byAgent = "createdBy" in command && command.createdBy === "agent";
  const running = investigation.status === "running";
  // The investigation decides when its ledger ends; the agent cannot end, replace or revive it.
  if (byAgent && running && command.type === "ledger.close") {
    return "The investigation closes its own ledger when an approach passes the refuter or the budget runs out. Keep working the approaches, or ask the user to stop it.";
  }
  if (byAgent && running && command.type === "ledger.create") {
    return "An investigation is running on this thread. Work its approaches; a new ledger would replace it.";
  }
  if (byAgent && !running && command.type === "ledger.reopen") {
    return `This ledger's investigation has ended (${investigation.status}). Only the user can reopen it.`;
  }
  const live = () =>
    ledger.items.filter((item) => isApproachItem(investigation, item) && isLiveApproach(item))
      .length;
  const overCap = (adding: number) =>
    live() + adding > investigation.parallelApproaches
      ? `The investigation runs at most ${investigation.parallelApproaches} approaches at once; ${live()} are still being explored or judged. Add more once one is refuted.`
      : undefined;
  if (command.type === "ledger.item.add") {
    const added = command.items.filter(
      (draft) =>
        draft.parentItemId === investigation.approachesItemId && draft.deferReason === undefined,
    ).length;
    if (added === 0) return undefined;
    if (investigation.status !== "running") {
      return `The investigation has ended (${investigation.status}); it takes no new approaches.`;
    }
    return overCap(added);
  }
  if (command.type !== "ledger.item.update") return undefined;
  const item = ledger.items.find(({ id }) => id === command.itemId);
  if (item === undefined) return undefined;
  if (
    byAgent &&
    running &&
    item.id === investigation.approachesItemId &&
    command.status !== undefined &&
    command.status !== item.status
  ) {
    return `The server manages the ${investigation.approachesItemId} item; it closes when an approach passes the refuter.`;
  }
  if (command.parentItemId !== undefined) {
    if (item.id === investigation.approachesItemId) {
      return `The ${investigation.approachesItemId} item holds the investigation's approaches and cannot move.`;
    }
    const wasApproach = isApproachItem(investigation, item);
    const becomesApproach = command.parentItemId === investigation.approachesItemId;
    if (wasApproach !== becomesApproach) {
      return wasApproach
        ? `Item ${item.id} is an approach and cannot leave ${investigation.approachesItemId}.`
        : `Item ${item.id} cannot move under ${investigation.approachesItemId}. Add a new approach item instead, so the refuter judges it.`;
    }
  }
  // Reviving a finished approach takes a slot like adding one.
  const revives =
    isApproachItem(investigation, item) &&
    !isUnfinished(item) &&
    (command.status === "open" || command.status === "in_progress");
  return revives ? overCap(1) : undefined;
}

/**
 * Marks a verdict recorded on an approach as the refuter's, which judged it (the judge picks the
 * refuter prompt by the same test). Any marker the command carried is replaced, so only this
 * planner attests it.
 */
export function stampRefuterVerdict(
  command: LedgerCommand,
  ledger: Ledger | undefined,
  planned: ReadonlyArray<PlannedLedgerEvent>,
): ReadonlyArray<PlannedLedgerEvent> {
  if (command.type !== "ledger.item.verdict.record") return planned;
  const investigation = ledger?.investigation;
  const before = ledger?.items.find(({ id }) => id === command.itemId);
  const refuter =
    investigation !== undefined && before !== undefined && isApproachItem(investigation, before);
  return planned.map((event) => {
    if (event.type !== "ledger.item.updated" || event.payload.item.id !== command.itemId) {
      return event;
    }
    const verdict = event.payload.item.verdict;
    if (verdict === null) return event;
    const { refuter: _claimed, ...plain } = verdict;
    return {
      ...event,
      payload: {
        ...event.payload,
        item: { ...event.payload.item, verdict: refuter ? { ...plain, refuter: true } : plain },
      },
    };
  });
}

/** Server-only spend report: changes the record only when the figure or its certainty moved. */
export function planInvestigationSpend(
  ledger: Ledger | undefined,
  input: { readonly spentUsd: number; readonly costUnknown: boolean },
  now: DateTime.Utc,
): ReadonlyArray<PlannedLedgerEvent> {
  const investigation = ledger?.investigation;
  if (ledger === undefined || investigation?.status !== "running") return [];
  const spentUsd = Math.round(input.spentUsd * 100) / 100;
  if (
    investigation.spentUsd === spentUsd &&
    (investigation.costUnknown === true) === input.costUnknown
  ) {
    return [];
  }
  const { costUnknown: _old, ...rest } = investigation;
  return [
    {
      type: "ledger.investigation.updated",
      payload: {
        ledgerId: ledger.id,
        investigation: { ...rest, spentUsd, ...(input.costUnknown ? { costUnknown: true } : {}) },
        updatedAt: now,
      },
    },
  ];
}

/**
 * The events a command planned, plus the solve they cause: an approach closing on a refuter's
 * pass. A close carried by any other verdict does not count, whatever path brought it there.
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
    event.payload.item.verdict?.outcome === "pass" &&
    event.payload.item.verdict.refuter === true &&
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

/**
 * Why `delegate_task` refuses a new worker on an investigation thread. An ended investigation
 * takes none, whatever its ledger's open state (a reopen does not revive it); a running one takes
 * no more than its parallel limit. `activeWorkers` counts running non-judge children; judges are
 * exempt, as are workers of workers, which this thread's own cap does not see.
 */
export function investigationDelegationProblem(input: {
  readonly ledger: Ledger | undefined;
  readonly activeWorkers: number;
}): string | undefined {
  const investigation = input.ledger?.investigation;
  if (investigation === undefined) return undefined;
  if (investigation.status !== "running") {
    return `This thread's investigation has ended (${investigation.status}${investigation.endReason === undefined ? "" : `: ${investigation.endReason}`}), and its workers were stopped. Do not start new ones; write the report, or ask the user before starting new work.`;
  }
  if (input.activeWorkers >= investigation.parallelApproaches) {
    return `The investigation runs at most ${investigation.parallelApproaches} workers at once and ${input.activeWorkers} are running. Wait for one to finish before starting another.`;
  }
  return undefined;
}

/** How far up the subagent chain the check looks; deeper delegation trees are not expected. */
const MAX_INVESTIGATION_DEPTH = 8;

/** The records the walk reads per thread. */
export interface InvestigationChainRecords {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage">;
  readonly ledger?: Ledger | undefined;
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "origin" | "role" | "status">>;
}

/**
 * Why `delegate_task` refuses the caller a new worker: its own investigation caps its running
 * workers, and walking up the subagent chain, an ended investigation refuses its workers' workers
 * too, so stopping the run cannot be outlived by a grandchild.
 */
export const findInvestigationDelegationRefusal = Effect.fn("Investigation.findDelegationRefusal")(
  function* <E>(
    callerThreadId: ThreadId,
    read: (threadId: ThreadId) => Effect.Effect<InvestigationChainRecords, E>,
  ): Effect.fn.Return<string | undefined, E> {
    let threadId: ThreadId | null = callerThreadId;
    const visited = new Set<ThreadId>();
    while (threadId !== null && !visited.has(threadId) && visited.size < MAX_INVESTIGATION_DEPTH) {
      visited.add(threadId);
      const records: InvestigationChainRecords = yield* read(threadId);
      const { thread, ledger, subagents } = records;
      const activeWorkers =
        threadId === callerThreadId
          ? subagents.filter(
              (task) =>
                task.origin === "app_owned" &&
                task.role !== "judge" &&
                isOrchestrationV2WorkActive(task.status),
            ).length
          : 0;
      const problem = investigationDelegationProblem({ ledger, activeWorkers });
      if (problem !== undefined) return problem;
      threadId =
        thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
    }
    return undefined;
  },
);

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
