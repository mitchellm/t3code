import {
  CommandId,
  type Ledger,
  LedgerId,
  type LedgerInvestigation,
  MessageId,
  OrchestrationInvestigationError,
  type OrchestrationStartInvestigationInput,
  type OrchestrationStartInvestigationResult,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatInvestigationBudget,
  investigationBudgetUse,
  investigationDeadlineMs,
} from "@t3tools/shared/investigation";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as UsageService from "../usage/UsageService.ts";
import { lookupRate, type RateTable } from "../usage/usagePricing.ts";
import { APPROACHES_ITEM_ID } from "./Investigation.ts";
import * as Orchestrator from "./Orchestrator.ts";

/**
 * Fork: the server half of Investigate mode. Starting writes the ledger, pins the criteria and
 * sends the kickoff; the solve itself is decided in the ledger planner. This service watches the
 * budget (a deadline timer per investigation, and spend checked whenever a turn or child task
 * ends), ends an exhausted or stopped investigation, and asks the planner for the report.
 */

export interface InvestigationDeps {
  readonly orchestrator: Pick<
    Orchestrator.OrchestratorV2["Service"],
    "dispatch" | "getThreadRecords"
  >;
  /** Rates for pricing token usage; only read when a budget has dollars. */
  readonly rateTable: Effect.Effect<RateTable>;
}

const fail = (message: string, cause?: unknown) =>
  new OrchestrationInvestigationError({ message, ...(cause === undefined ? {} : { cause }) });

const dispatchError = (action: string) => (cause: Orchestrator.OrchestratorV2Error) => {
  const detail =
    cause._tag === "OrchestratorDispatchError" && typeof cause.cause === "string"
      ? cause.cause
      : cause.message;
  return fail(`Could not ${action}: ${detail}`, cause);
};

const investigationLedgerId = (requestId: string) =>
  LedgerId.make(`ledger:investigation:${requestId}`);

const criteriaPinId = (ledgerId: string) => `investigation-criteria:${ledgerId}`;

export const criteriaPinText = (solvedWhen: string) =>
  `Investigation success criteria, set by the user (verbatim). The investigation is solved only when these hold:\n\n${solvedWhen}`;

export function kickoffText(input: {
  readonly goal: string;
  readonly solvedWhen: string;
  readonly investigation: Pick<LedgerInvestigation, "budget" | "parallelApproaches">;
}): string {
  const n = input.investigation.parallelApproaches;
  return [
    input.goal,
    "",
    `Run this as an investigation with up to ${n} approaches in parallel. The budget is ${formatInvestigationBudget(input.investigation)}.`,
    "",
    "Solved when (my criteria, verbatim):",
    input.solvedWhen,
    "",
    "How to run it:",
    `1. Propose up to ${n} distinct approaches. Add each as a ledger item under the item "${APPROACHES_ITEM_ID}" (ledger_add_items with parentItemId "${APPROACHES_ITEM_ID}"): the title names the approach, the acceptance says what it would show.`,
    '2. Work each approach in its own delegated child: delegate_task with role "worker", in the background, one per approach. Ask each to come back with a thesis and the evidence for it.',
    "3. When a child reports a thesis, close its approach item with the thesis and evidence as the evidence. The server's refuter then judges it against the criteria above.",
    "4. A FAIL hands the item back with the refutation. Either close it again with stronger evidence, or drop it (with the refutation as the reason) to free its slot and add a variant as a new approach item. Every open or in-progress approach counts toward the limit.",
    "5. The first thesis that passes solves the investigation: the server stops every other child and asks you for the report. The server manages the Approaches item and the ledger: do not close them or start another ledger.",
  ].join("\n");
}

function reportText(investigation: LedgerInvestigation): string {
  return investigation.status === "solved"
    ? `The investigation is solved: ${investigation.endReason ?? "an approach passed the refuter."} The other approaches were stopped. Write the final report: the answer, the evidence that meets the criteria, and what the other approaches found or ruled out.`
    : `The investigation ran out of budget (${investigation.endReason ?? formatInvestigationBudget(investigation)}). Every child was stopped. Write a best-so-far report: what each approach found, the strongest thesis and why it did not pass, and what you would try next.`;
}

/**
 * Dollars spent by the investigation so far: every provider turn on the thread and on every task
 * under it, at any depth, that started after it, priced by the run's model. `unpricedTurns` counts
 * turns with usage that no rate covered, so the spend is a floor rather than the whole cost.
 */
export function investigationSpendUsd(input: {
  readonly investigation: LedgerInvestigation;
  readonly threads: ReadonlyArray<{
    readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
  }>;
  readonly rates: RateTable;
}): { readonly usd: number; readonly unpricedTurns: number } {
  const startMs = DateTime.toEpochMillis(input.investigation.startedAt);
  let total = 0;
  let unpricedTurns = 0;
  for (const thread of input.threads) {
    const modelByNode = new Map(
      thread.runs.flatMap((run) =>
        run.rootNodeId === null ? [] : [[run.rootNodeId as string, run.modelSelection.model]],
      ),
    );
    const fallbackModel = thread.runs.at(-1)?.modelSelection.model;
    for (const turn of thread.providerTurns) {
      const usage = turn.turnTokenUsage;
      if (usage === undefined || turn.startedAt === null) continue;
      if (DateTime.toEpochMillis(turn.startedAt) < startMs) continue;
      const model = modelByNode.get(turn.nodeId) ?? fallbackModel;
      const rate = model === undefined ? null : lookupRate(input.rates, model);
      if (rate === null) {
        unpricedTurns += 1;
        continue;
      }
      const inputTokens = usage.inputTokens ?? 0;
      const cached = usage.cachedInputTokens ?? 0;
      const creation = usage.cacheCreationTokens ?? 0;
      total +=
        Math.max(0, inputTokens - cached - creation) * rate.inputCostPerToken +
        cached * rate.cacheReadCostPerToken +
        creation * rate.cacheCreationCostPerToken +
        (usage.outputTokens ?? 0) * rate.outputCostPerToken;
    }
  }
  return { usd: total, unpricedTurns };
}

const runningInvestigation = (ledger: Ledger | undefined) =>
  ledger?.investigation?.status === "running" ? ledger.investigation : undefined;

// Bounds the walk over tasks under tasks, so a runaway tree cannot stall every budget check.
const MAX_SPEND_THREADS = 200;

/** The thread's turns and those of every delegated task below it, breadth first. */
const readTreeTurns = Effect.fn("InvestigationService.readTreeTurns")(function* (
  deps: InvestigationDeps,
  threadId: ThreadId,
) {
  const threads: Array<{
    readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
  }> = [];
  const seen = new Set<string>([threadId]);
  let frontier: ReadonlyArray<ThreadId> = [threadId];
  while (frontier.length > 0 && seen.size <= MAX_SPEND_THREADS) {
    const records = yield* Effect.forEach(
      frontier,
      (id) =>
        deps.orchestrator
          .getThreadRecords(id, ["providerTurns", "runs", "subagents"])
          // A deleted child only loses its own spend, not the whole check.
          .pipe(Effect.orElseSucceed(() => ({ providerTurns: [], runs: [], subagents: [] }))),
      { concurrency: 4 },
    );
    const next: Array<ThreadId> = [];
    for (const record of records) {
      threads.push(record);
      for (const task of record.subagents) {
        if (task.origin !== "app_owned" || task.childThreadId === null) continue;
        if (seen.has(task.childThreadId)) continue;
        seen.add(task.childThreadId);
        next.push(task.childThreadId);
      }
    }
    frontier = next;
  }
  return threads;
});

/**
 * Ends the investigation when a budget is used up, and records the spend for the run view when it
 * has a dollar budget. Safe to call at any time and repeatedly: the end command is keyed by the
 * ledger, and the planner ignores an end or a spend report once it has ended.
 */
export const checkInvestigationBudget = Effect.fn("InvestigationService.checkBudget")(function* (
  deps: InvestigationDeps,
  threadId: ThreadId,
) {
  // Runs on every completed turn of every thread, so the ledger alone is read first.
  const { ledger } = yield* deps.orchestrator.getThreadRecords(threadId, ["ledger"]);
  const investigation = runningInvestigation(ledger);
  if (ledger === undefined || investigation === undefined) return;
  let spentUsd = 0;
  if (investigation.budget.usd !== undefined) {
    const rates = yield* deps.rateTable;
    const spend = investigationSpendUsd({
      investigation,
      threads: yield* readTreeTurns(deps, threadId),
      rates,
    });
    spentUsd = spend.usd;
    const costUnknown = rates.size === 0 || spend.unpricedTurns > 0;
    if (costUnknown) {
      // A dollars-only budget cannot end on cost it cannot price; say so rather than wait quietly.
      yield* Effect.logWarning("investigation spend is partly unpriced", {
        threadId,
        ledgerId: ledger.id,
        ratesLoaded: rates.size > 0,
        unpricedTurns: spend.unpricedTurns,
        timeBudget: investigation.budget.minutes !== undefined,
      });
    }
    const cents = Math.round(spentUsd * 100);
    yield* deps.orchestrator.dispatch({
      type: "ledger.investigation.spend",
      commandId: CommandId.make(
        `server:investigation-spend:${ledger.id}:${cents}:${costUnknown ? "unknown" : "priced"}`,
      ),
      threadId,
      ledgerId: ledger.id,
      spentUsd,
      costUnknown,
    });
  }
  const use = investigationBudgetUse({
    investigation,
    nowMs: DateTime.toEpochMillis(yield* DateTime.now),
    spentUsd,
  });
  if (use.exhausted === null) return;
  yield* deps.orchestrator.dispatch({
    type: "ledger.investigation.end",
    commandId: CommandId.make(`server:investigation-exhausted:${ledger.id}`),
    threadId,
    ledgerId: ledger.id,
    status: "exhausted",
    reason:
      use.exhausted === "time"
        ? `The ${investigation.budget.minutes} minute budget is used up.`
        : `The $${investigation.budget.usd?.toFixed(2)} budget is used up ($${spentUsd.toFixed(2)} spent).`,
  });
});

/** Waits for the time budget's deadline, then checks the budget. */
export const awaitInvestigationDeadline = Effect.fn("InvestigationService.awaitDeadline")(
  function* (deps: InvestigationDeps, threadId: ThreadId, investigation: LedgerInvestigation) {
    const deadlineMs = investigationDeadlineMs(investigation);
    if (deadlineMs === null) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (deadlineMs > nowMs) yield* Effect.sleep(Duration.millis(deadlineMs - nowMs));
    yield* checkInvestigationBudget(deps, threadId);
  },
);

/** Asks the planner for the report once the investigation is solved or out of budget. */
export const requestInvestigationReport = Effect.fn("InvestigationService.requestReport")(
  function* (
    deps: InvestigationDeps,
    threadId: ThreadId,
    ledgerId: LedgerId,
    investigation: LedgerInvestigation,
  ) {
    // Stop is the user's own call; they ask for a write-up if they want one.
    if (investigation.status !== "solved" && investigation.status !== "exhausted") return;
    const messageId = MessageId.make(`message:investigation-report:${ledgerId}`);
    // Command receipts are pruned after a week, so the message itself says it was already asked.
    const { messages } = yield* deps.orchestrator.getThreadRecords(threadId, ["messages"], {
      messageIds: [messageId],
    });
    if (messages.some((message) => message.id === messageId)) return;
    yield* deps.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:investigation-report:${ledgerId}`),
      messageId,
      threadId,
      text: reportText(investigation),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  },
);

export const startInvestigation = Effect.fn("InvestigationService.start")(function* (
  deps: InvestigationDeps,
  input: OrchestrationStartInvestigationInput,
) {
  const { threadId } = input;
  const ledgerId = investigationLedgerId(input.requestId);
  // Every step is keyed by the request, so a retried start replays rather than repeats.
  const key = (step: string) =>
    CommandId.make(`investigation:${threadId}:${input.requestId}:${step}`);
  const creationSource = input.creationSource ?? "web";
  yield* deps.orchestrator
    .dispatch({
      type: "ledger.investigation.start",
      commandId: key("start"),
      threadId,
      ledgerId,
      goal: input.goal,
      solvedWhen: input.solvedWhen,
      budget: input.budget,
      parallelApproaches: input.parallelApproaches,
    })
    .pipe(Effect.mapError(dispatchError("start the investigation")));
  // Pinned so the criteria survive compaction on every provider that delivers pins.
  yield* deps.orchestrator
    .dispatch({
      type: "thread.rule-pin.add",
      commandId: key("pin"),
      threadId,
      pinId: criteriaPinId(ledgerId),
      text: criteriaPinText(input.solvedWhen),
    })
    .pipe(Effect.mapError(dispatchError("pin the criteria")));
  yield* deps.orchestrator
    .dispatch({
      type: "message.dispatch",
      commandId: key("kickoff"),
      messageId: MessageId.make(`message:investigation:${threadId}:${input.requestId}`),
      threadId,
      text: kickoffText({ goal: input.goal, solvedWhen: input.solvedWhen, investigation: input }),
      attachments: [],
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource,
    })
    .pipe(Effect.mapError(dispatchError("send the goal")));
  return { threadId, ledgerId } satisfies OrchestrationStartInvestigationResult;
});

export const stopInvestigation = Effect.fn("InvestigationService.stop")(function* (
  deps: InvestigationDeps,
  threadId: ThreadId,
) {
  const { ledger } = yield* deps.orchestrator
    .getThreadRecords(threadId, ["ledger"])
    .pipe(Effect.mapError((cause) => fail("Could not read the investigation.", cause)));
  if (ledger === undefined || runningInvestigation(ledger) === undefined) {
    return yield* fail("This thread has no running investigation.");
  }
  yield* deps.orchestrator
    .dispatch({
      type: "ledger.investigation.end",
      commandId: CommandId.make(`server:investigation-stop:${ledger.id}`),
      threadId,
      ledgerId: ledger.id,
      status: "stopped",
      reason: "Stopped by the user.",
    })
    .pipe(Effect.mapError(dispatchError("stop the investigation")));
  // The planner stops too. No reason, so it reads as the user's Stop; the end's own effect has
  // already queued stopping the children.
  yield* deps.orchestrator
    .dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`server:investigation-stop-thread:${ledger.id}`),
      threadId,
      stopDelegatedTasks: false,
    })
    .pipe(Effect.mapError(dispatchError("stop the planner")));
});

export class InvestigationService extends Context.Service<
  InvestigationService,
  {
    readonly start: (
      input: OrchestrationStartInvestigationInput,
    ) => Effect.Effect<OrchestrationStartInvestigationResult, OrchestrationInvestigationError>;
    readonly stop: (threadId: ThreadId) => Effect.Effect<void, OrchestrationInvestigationError>;
  }
>()("t3/orchestration-v2/InvestigationService") {}

// Long enough to cover a restart or an outage; older ended investigations are not revisited.
const REPORT_RESCAN_WINDOW_MS = 24 * 60 * 60 * 1_000;

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** @public */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const usage = yield* UsageService.UsageService;
  const sql = yield* SqlClient.SqlClient;
  const deps: InvestigationDeps = { orchestrator, rateTable: usage.rateTable };

  const logged = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning(label, { cause })),
    );

  const deadlines = yield* FiberMap.make<string>();
  const armDeadline = (threadId: ThreadId, ledgerId: string, investigation: LedgerInvestigation) =>
    investigation.status === "running" && investigation.budget.minutes !== undefined
      ? FiberMap.run(
          deadlines,
          ledgerId,
          logged(
            "investigation deadline check failed",
            awaitInvestigationDeadline(deps, threadId, investigation),
          ),
          { onlyIfMissing: true },
        ).pipe(Effect.asVoid)
      : Effect.void;

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      switch (event.type) {
        case "ledger.created":
          return event.payload.investigation === undefined
            ? Effect.void
            : armDeadline(event.threadId, event.payload.id, event.payload.investigation);
        case "ledger.investigation.updated":
          return event.payload.investigation.status === "running"
            ? Effect.void
            : FiberMap.remove(deadlines, event.payload.ledgerId).pipe(
                Effect.andThen(
                  logged(
                    "investigation report request failed",
                    requestInvestigationReport(
                      deps,
                      event.threadId,
                      event.payload.ledgerId,
                      event.payload.investigation,
                    ),
                  ),
                ),
              );
        // Spend lands when a turn or a child task ends, so that is when dollars are checked.
        case "run.updated":
          return event.payload.status === "completed"
            ? logged(
                "investigation budget check failed",
                checkInvestigationBudget(deps, event.threadId),
              )
            : Effect.void;
        case "subagent.updated":
          return event.payload.origin === "app_owned" && TERMINAL_TASK.has(event.payload.status)
            ? logged(
                "investigation budget check failed",
                checkInvestigationBudget(deps, event.payload.threadId),
              )
            : Effect.void;
        default:
          return Effect.void;
      }
    }),
  );

  // Timers and report requests live in memory. A restart re-arms running investigations, and
  // re-asks for the report of one that ended while the server was down (recently: an old one's
  // planner has long moved on). The report checks for its own message, so a repeat is a no-op.
  yield* forkParked(
    logged(
      "investigation startup scan failed",
      Effect.gen(function* () {
        const cutoff = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, { milliseconds: REPORT_RESCAN_WINDOW_MS }),
        );
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_ledgers
          WHERE json_extract(payload_json, '$.investigation.status') = 'running'
            OR (
              json_extract(payload_json, '$.investigation.status') IN ('solved', 'exhausted')
              AND json_extract(payload_json, '$.investigation.endedAt') >= ${cutoff}
            )
        `;
        for (const row of rows) {
          const threadId = ThreadId.make(row.thread_id);
          const { ledger } = yield* orchestrator.getThreadRecords(threadId, ["ledger"]);
          const investigation = ledger?.investigation;
          if (ledger === undefined || investigation === undefined) continue;
          if (investigation.status === "running") {
            yield* armDeadline(threadId, ledger.id, investigation);
            yield* logged(
              "investigation budget check failed",
              checkInvestigationBudget(deps, threadId),
            );
          } else {
            yield* logged(
              "investigation report request failed",
              requestInvestigationReport(deps, threadId, ledger.id, investigation),
            );
          }
        }
      }),
    ),
  );

  return InvestigationService.of({
    start: (input) => startInvestigation(deps, input),
    stop: (threadId) => stopInvestigation(deps, threadId),
  });
});

export const layer = Layer.effect(InvestigationService, make);
