import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type Ledger,
  LedgerId,
  LedgerItemId,
  type LedgerItemVerdict,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { investigationBudgetUse, investigationLanes } from "@t3tools/shared/investigation";
import { applyLedgerEvent } from "@t3tools/shared/taskLedger";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Result from "effect/Result";

import {
  APPROACHES_ITEM_ID,
  delegationRefusalFor,
  findInvestigationLock,
  type InvestigationChainRecords,
  investigationDelegationProblem,
  investigationEffects,
  investigationSpawnGuard,
  investigationSpawnRefusal,
  withInvestigationDelegationLease,
} from "./Investigation.ts";
import {
  type LedgerCommand,
  ledgerEventFromPlan,
  type PlannedLedgerEvent,
  planLedgerCommand,
} from "./TaskLedger.ts";

const start = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const threadId = ThreadId.make("thread:investigation");
const ledgerId = LedgerId.make("ledger:investigation");
const commandId = CommandId.make("command:investigation");
const id = (name: string) => LedgerItemId.make(name);
const at = (minutes: number) => DateTime.add(start, { minutes });

/** No user has written since the end: the case every refusal below is about. */
const delegationProblem = (ledger: Ledger, activeWorkers: number) =>
  investigationDelegationProblem({ lock: investigationSpawnGuard(ledger, null), activeWorkers });

const delegationRefusal = <E>(
  caller: ThreadId,
  read: (threadId: ThreadId) => Effect.Effect<InvestigationChainRecords, E>,
) =>
  findInvestigationLock(caller, read, () => Effect.succeed(null)).pipe(
    Effect.map(delegationRefusalFor),
  );

const verdict = (outcome: "pass" | "fail"): LedgerItemVerdict => ({
  outcome,
  judge: { instanceId: ProviderInstanceId.make("judge"), model: "judge-model" },
  notes: outcome === "pass" ? "Holds against the criteria." : "The repro still fails.",
  at: start,
});

/** Plans a command and folds its events in, as the projection would. */
function step(
  ledger: Ledger | undefined,
  command: LedgerCommand,
  now: DateTime.Utc,
  requiresJudge?: boolean,
): { readonly ledger: Ledger; readonly planned: ReadonlyArray<PlannedLedgerEvent> } {
  const planned = planLedgerCommand({
    command,
    ledger,
    now,
    ...(requiresJudge === undefined ? {} : { requiresJudge }),
  });
  if (Result.isFailure(planned)) throw new Error(planned.failure);
  let next = ledger;
  for (const event of planned.success) {
    next = applyLedgerEvent(next, {
      ...ledgerEventFromPlan(event, {
        threadId,
        providerInstanceId: ProviderInstanceId.make("planner"),
        occurredAt: now,
      }),
      id: EventId.make(`event:${event.type}`),
    });
  }
  return { ledger: next!, planned: planned.success };
}

const startCommand: LedgerCommand = {
  type: "ledger.investigation.start",
  commandId,
  threadId,
  ledgerId,
  goal: "Find why the sync job drops rows",
  solvedWhen: "A failing test reproduces the drop and passes with the fix.",
  budget: { minutes: 30 },
  parallelApproaches: 3,
};

/** A running investigation with approaches a, b and c, and a's thesis waiting on the refuter. */
function running(): Ledger {
  let ledger = step(undefined, startCommand, start, true).ledger;
  ledger = step(
    ledger,
    {
      type: "ledger.item.add",
      commandId,
      threadId,
      ledgerId,
      items: ["a", "b", "c"].map((name) => ({
        id: id(name),
        title: `Approach ${name}`,
        acceptance: "thesis",
        parentItemId: APPROACHES_ITEM_ID,
      })),
    },
    at(1),
  ).ledger;
  return step(
    ledger,
    {
      type: "ledger.item.update",
      commandId,
      threadId,
      ledgerId,
      itemId: id("a"),
      status: "closed",
      evidence: "Rows drop when the batch crosses a page boundary.",
      createdBy: "agent",
    },
    at(2),
  ).ledger;
}

// Answers the item's pending close request, as the server judge does (LedgerJudgement).
const recordVerdict = (ledger: Ledger, name: string, outcome: "pass" | "fail"): LedgerCommand => {
  const item = ledger.items.find((candidate) => candidate.id === id(name));
  return {
    type: "ledger.item.verdict.record",
    commandId,
    threadId,
    ledgerId,
    itemId: id(name),
    verdict: verdict(outcome),
    ...(item === undefined ? {} : { judgingRequestedAt: item.updatedAt }),
  };
};

const statusOf = (ledger: Ledger, name: string) =>
  ledger.items.find((item) => item.id === id(name))?.status;

describe("investigation state machine", () => {
  it("starts with the criteria as the win condition and refuses a ledger without a judge", () => {
    const { ledger } = step(undefined, startCommand, start, true);
    assert.strictEqual(ledger.investigation?.status, "running");
    assert.deepStrictEqual(ledger.winConditions, [
      startCommand.type === "ledger.investigation.start" ? startCommand.solvedWhen : "",
    ]);
    assert.strictEqual(ledger.requiresJudge, true);
    const refused = planLedgerCommand({
      command: startCommand,
      ledger: undefined,
      now: start,
      requiresJudge: false,
    });
    assert.isTrue(Result.isFailure(refused));
  });

  it("a thesis waits on the refuter, and a FAIL hands the approach back refuted", () => {
    const thesis = running();
    assert.strictEqual(
      investigationLanes(thesis).find((lane) => lane.item.id === id("a"))?.status,
      "judging",
    );
    const { ledger, planned } = step(thesis, recordVerdict(thesis, "a", "fail"), at(3));
    assert.strictEqual(statusOf(ledger, "a"), "in_progress");
    assert.strictEqual(ledger.investigation?.status, "running");
    assert.strictEqual(ledger.closedAt, null);
    assert.strictEqual(
      investigationLanes(ledger).find((lane) => lane.item.id === id("a"))?.status,
      "refuted",
    );
    assert.deepStrictEqual(investigationEffects({ commandId, threadId }, planned), []);
  });

  it("the first PASS solves it, drops the other approaches and stops every child", () => {
    const { ledger, planned } = step(running(), recordVerdict(running(), "a", "pass"), at(4));
    assert.strictEqual(ledger.investigation?.status, "solved");
    assert.strictEqual(ledger.investigation?.solvedItemId, id("a"));
    assert.strictEqual(statusOf(ledger, "a"), "closed");
    assert.strictEqual(statusOf(ledger, "b"), "dropped");
    assert.strictEqual(statusOf(ledger, "c"), "dropped");
    assert.strictEqual(statusOf(ledger, "approaches"), "closed");
    assert.notStrictEqual(ledger.closedAt, null);
    const effects = investigationEffects({ commandId, threadId }, planned);
    assert.deepStrictEqual(
      effects.map((effect) => effect.request.type),
      ["delegated-tasks.stop"],
    );
  });

  it("budget exhaustion ends it exhausted and stops every child; a later end is a no-op", () => {
    const thesis = running();
    const use = investigationBudgetUse({
      investigation: thesis.investigation!,
      nowMs: DateTime.toEpochMillis(at(30)),
      spentUsd: 0,
    });
    assert.strictEqual(use.exhausted, "time");
    const end: LedgerCommand = {
      type: "ledger.investigation.end",
      commandId,
      threadId,
      ledgerId,
      status: "exhausted",
      reason: "The 30 minute budget is used up.",
    };
    const { ledger, planned } = step(thesis, end, at(30));
    assert.strictEqual(ledger.investigation?.status, "exhausted");
    for (const name of ["a", "b", "c", "approaches"])
      assert.strictEqual(statusOf(ledger, name), "dropped");
    assert.strictEqual(
      ledger.items.some((item) => item.judging === true),
      false,
    );
    assert.strictEqual(investigationEffects({ commandId, threadId }, planned).length, 1);
    const again = planLedgerCommand({ command: end, ledger, now: at(31) });
    assert.isTrue(Result.isSuccess(again) && again.success.length === 0);
  });

  it("Stop all ends it stopped and stops every child", () => {
    const { ledger, planned } = step(
      running(),
      {
        type: "ledger.investigation.end",
        commandId,
        threadId,
        ledgerId,
        status: "stopped",
        reason: "Stopped by the user.",
      },
      at(5),
    );
    assert.strictEqual(ledger.investigation?.status, "stopped");
    assert.strictEqual(statusOf(ledger, "b"), "dropped");
    assert.strictEqual(investigationEffects({ commandId, threadId }, planned).length, 1);
  });

  const addVariant: LedgerCommand = {
    type: "ledger.item.add",
    commandId,
    threadId,
    ledgerId,
    items: [{ id: id("d"), title: "Approach d", acceptance: "", parentItemId: APPROACHES_ITEM_ID }],
  };
  const agentUpdate = (
    name: string,
    fields: Partial<Extract<LedgerCommand, { type: "ledger.item.update" }>>,
  ): LedgerCommand => ({
    type: "ledger.item.update",
    commandId,
    threadId,
    ledgerId,
    itemId: id(name),
    createdBy: "agent",
    ...fields,
  });

  it("the cap counts every active approach, refuted ones too, until a refuted one is dropped", () => {
    const full = running();
    assert.isTrue(
      Result.isFailure(planLedgerCommand({ command: addVariant, ledger: full, now: at(6) })),
    );
    const refuted = step(full, recordVerdict(full, "a", "fail"), at(7)).ledger;
    assert.isTrue(
      Result.isFailure(planLedgerCommand({ command: addVariant, ledger: refuted, now: at(8) })),
      "a refuted approach handed back in progress still holds its slot",
    );
    // Dropping a refuted approach claims nothing, so the agent may do it on the judged ledger.
    const dropped = step(
      refuted,
      agentUpdate("a", { status: "dropped", dropReason: "Refuted: the repro still fails." }),
      at(9),
    ).ledger;
    assert.isTrue(
      Result.isSuccess(planLedgerCommand({ command: addVariant, ledger: dropped, now: at(10) })),
    );
    // An approach still being explored or judged is not the agent's to drop.
    const judging = planLedgerCommand({
      command: agentUpdate("a", { status: "dropped", dropReason: "giving up" }),
      ledger: full,
      now: at(9),
    });
    assert.isTrue(Result.isFailure(judging));
  });

  it("while running, the agent cannot close the ledger, replace it, or move the Approaches item", () => {
    // Started, no approaches yet: the Approaches item has no unfinished sub-items in the way.
    const fresh = step(undefined, startCommand, start, true).ledger;
    const refusedForAgent = (command: LedgerCommand, ledger: Ledger) =>
      Result.isFailure(planLedgerCommand({ command, ledger, now: at(6) }));
    assert.isTrue(
      refusedForAgent(agentUpdate("approaches", { status: "closed", evidence: "done" }), fresh),
      "status change on the server-managed Approaches item",
    );
    // The escape the ordinary judge would open: Approaches closed, then the ledger.
    const approachesClosed: Ledger = {
      ...fresh,
      items: fresh.items.map((item) =>
        item.id === APPROACHES_ITEM_ID
          ? { ...item, status: "closed", evidence: "done", closedAt: at(5) }
          : item,
      ),
    };
    assert.isTrue(
      refusedForAgent(
        { type: "ledger.close", commandId, threadId, ledgerId, createdBy: "agent" },
        approachesClosed,
      ),
    );
    const replacement: LedgerCommand = {
      type: "ledger.create",
      commandId,
      threadId,
      ledgerId: LedgerId.make("ledger:escape"),
      title: "Something else",
      startState: "",
      checkpoints: [],
      winConditions: [],
      items: [],
      createdBy: "agent",
    };
    assert.isTrue(refusedForAgent(replacement, { ...approachesClosed, closedAt: at(6) }));
  });

  it("after it ends, the agent cannot reopen the ledger; the user can", () => {
    const solved = step(running(), recordVerdict(running(), "a", "pass"), at(4)).ledger;
    const reopen = (createdBy?: "agent" | "user"): LedgerCommand => ({
      type: "ledger.reopen",
      commandId,
      threadId,
      ledgerId,
      ...(createdBy === undefined ? {} : { createdBy }),
    });
    assert.isTrue(
      Result.isFailure(planLedgerCommand({ command: reopen("agent"), ledger: solved, now: at(5) })),
    );
    assert.isTrue(
      Result.isSuccess(planLedgerCommand({ command: reopen(), ledger: solved, now: at(5) })),
    );
  });

  /** An item outside Approaches that the ordinary judge already passed. */
  function judgedOutside(): Ledger {
    let ledger = step(
      running(),
      {
        type: "ledger.item.add",
        commandId,
        threadId,
        ledgerId,
        items: [{ id: id("x"), title: "Side work", acceptance: "self-written" }],
      },
      at(6),
    ).ledger;
    ledger = step(
      ledger,
      {
        type: "ledger.item.update",
        commandId,
        threadId,
        ledgerId,
        itemId: id("x"),
        status: "in_progress",
        evidence: "It works.",
        createdBy: "agent",
      },
      at(7),
    ).ledger;
    // `ledger_request_judgement` records a verdict without a pending close request.
    return step(ledger, recordVerdict(ledger, "x", "pass"), at(8)).ledger;
  }

  it("refuses moving a judged item under Approaches, so the refuter cannot be skipped", () => {
    const moveAndClose = planLedgerCommand({
      command: {
        type: "ledger.item.update",
        commandId,
        threadId,
        ledgerId,
        itemId: id("x"),
        parentItemId: APPROACHES_ITEM_ID,
        status: "closed",
        createdBy: "agent",
      },
      ledger: judgedOutside(),
      now: at(9),
    });
    assert.isTrue(Result.isFailure(moveAndClose));
  });

  it("refuses moving an item into or out of Approaches, which would dodge the parallel cap", () => {
    const base = step(
      running(),
      {
        type: "ledger.item.add",
        commandId,
        threadId,
        ledgerId,
        items: [{ id: id("x"), title: "Side work", acceptance: "" }],
      },
      at(6),
    ).ledger;
    const moveIn = planLedgerCommand({
      command: {
        type: "ledger.item.update",
        commandId,
        threadId,
        ledgerId,
        itemId: id("x"),
        parentItemId: APPROACHES_ITEM_ID,
      },
      ledger: base,
      now: at(7),
    });
    assert.isTrue(Result.isFailure(moveIn), "a fourth live approach by moving one in");
    const moveOut = planLedgerCommand({
      command: {
        type: "ledger.item.update",
        commandId,
        threadId,
        ledgerId,
        itemId: id("b"),
        parentItemId: null,
      },
      ledger: base,
      now: at(7),
    });
    assert.isTrue(Result.isFailure(moveOut), "freeing a slot by moving one out");
  });

  it("delegate_task is refused once the investigation has ended, even on a reopened ledger", () => {
    const thesis = running();
    assert.strictEqual(delegationProblem(thesis, 0), undefined);
    const solved = step(thesis, recordVerdict(thesis, "a", "pass"), at(4)).ledger;
    assert.include(delegationProblem(solved, 0) ?? "", "has ended (solved");
    // Reopening does not revive the investigation, so its workers stay stopped.
    const reopened = step(
      solved,
      { type: "ledger.reopen", commandId, threadId, ledgerId },
      at(5),
    ).ledger;
    assert.isDefined(delegationProblem(reopened, 0));
  });

  it("delegate_task refuses a worker beyond the parallel limit while it runs", () => {
    const thesis = running();
    assert.strictEqual(delegationProblem(thesis, 2), undefined);
    assert.include(delegationProblem(thesis, 3) ?? "", "at most 3");
  });

  it("only a refuter's pass solves it: a plain pass on an approach item does not", () => {
    // The verdict is stamped as a refutation only when the item was an approach when judged.
    const { ledger } = step(running(), recordVerdict(running(), "a", "pass"), at(4));
    const solved = ledger.items.find((item) => item.id === id("a"));
    assert.strictEqual(solved?.verdict?.refuter, true);
    const unstamped: Ledger = {
      ...judgedOutside(),
      items: judgedOutside().items.map((item) =>
        item.id === id("x") ? { ...item, parentItemId: APPROACHES_ITEM_ID } : item,
      ),
    };
    const closed = step(
      unstamped,
      {
        type: "ledger.item.update",
        commandId,
        threadId,
        ledgerId,
        itemId: id("x"),
        status: "closed",
        createdBy: "agent",
      },
      at(9),
    ).ledger;
    assert.strictEqual(closed.investigation?.status, "running");
  });

  const chainLink = (
    ledger: Ledger | undefined,
    parentThreadId: ThreadId | null,
    subagents: InvestigationChainRecords["subagents"] = [],
  ): InvestigationChainRecords => ({
    thread: {
      lineage: {
        parentThreadId,
        relationshipToParent: parentThreadId === null ? null : "subagent",
        rootThreadId: threadId,
      },
    },
    ledger,
    subagents,
  });

  it.effect("a worker's worker is refused once the root investigation has ended", () =>
    Effect.gen(function* () {
      const child = ThreadId.make("thread:worker");
      const grandchild = ThreadId.make("thread:sub-worker");
      const solved = step(running(), recordVerdict(running(), "a", "pass"), at(4)).ledger;
      const chain: Record<string, InvestigationChainRecords> = {
        [threadId]: chainLink(solved, null),
        [child]: chainLink(undefined, threadId),
        [grandchild]: chainLink(undefined, child),
      };
      const refusal = yield* delegationRefusal(grandchild, (id) => Effect.succeed(chain[id]!));
      assert.include(refusal ?? "", "has ended (solved");
      // While it runs, a worker may start its own helpers; only the root's cap applies there.
      const live: Record<string, InvestigationChainRecords> = {
        ...chain,
        [threadId]: chainLink(running(), null),
      };
      assert.strictEqual(
        yield* delegationRefusal(grandchild, (id) => Effect.succeed(live[id]!)),
        undefined,
      );
    }),
  );

  it.effect("the investigation thread's cap counts running workers and exempts judges", () =>
    Effect.gen(function* () {
      const worker = { origin: "app_owned", role: "worker", status: "running" } as const;
      const judge = {
        origin: "app_owned",
        role: "judge",
        status: "running",
        serverJudge: true,
      } as const;
      const withChildren = (subagents: InvestigationChainRecords["subagents"]) =>
        delegationRefusal(threadId, () => Effect.succeed(chainLink(running(), null, subagents)));
      assert.strictEqual(yield* withChildren([worker, worker, judge, judge]), undefined);
      assert.include((yield* withChildren([worker, worker, worker, judge])) ?? "", "at most 3");
    }),
  );

  it.effect("a recorded agent-started judge does not dodge the cap", () =>
    Effect.gen(function* () {
      const worker = { origin: "app_owned", role: "worker", status: "running" } as const;
      const agentJudge = { origin: "app_owned", role: "judge", status: "running" } as const;
      const serverJudge = { ...agentJudge, serverJudge: true } as const;
      const refusal = (subagents: InvestigationChainRecords["subagents"]) =>
        delegationRefusal(threadId, () => Effect.succeed(chainLink(running(), null, subagents)));
      // delegate_task now refuses an agent-named judge, but one recorded before that still counts
      // as a worker; the server's judge does not.
      assert.include((yield* refusal([worker, worker, agentJudge])) ?? "", "at most 3");
      assert.strictEqual(yield* refusal([worker, worker, serverJudge, serverJudge]), undefined);
    }),
  );

  it.effect("two concurrent delegations cannot both pass the cap", () =>
    Effect.gen(function* () {
      // One slot left: two workers already run against a limit of three.
      const recorded = yield* Ref.make(2);
      const firstChecked = yield* Deferred.make<void>();
      const delegate = (isFirst: boolean) =>
        withInvestigationDelegationLease(
          threadId,
          Effect.gen(function* () {
            const refused = delegationProblem(running(), yield* Ref.get(recorded));
            if (refused !== undefined) return "refused" as const;
            if (isFirst) {
              // The first sits between its check and its dispatch, where the race lives, until
              // the test clock moves.
              yield* Deferred.succeed(firstChecked, undefined);
              yield* Effect.sleep("1 second");
            }
            yield* Ref.update(recorded, (count) => count + 1);
            return "started" as const;
          }),
        );
      const first = yield* Effect.forkChild(delegate(true));
      yield* Deferred.await(firstChecked);
      // Needs no time: without the lease it checks and dispatches at once.
      const second = yield* Effect.forkChild(delegate(false));
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        [yield* Fiber.join(first), yield* Fiber.join(second)],
        ["started", "refused"],
      );
      assert.strictEqual(yield* Ref.get(recorded), 3);
    }),
  );

  it("the spawn guard locks a running thread, and an ended one until the user writes again", () => {
    const solved = step(running(), recordVerdict(running(), "a", "pass"), at(4)).ledger;
    assert.strictEqual(investigationSpawnGuard(running(), null).state, "running");
    // No user message since the end (a report or wake turn is not one): still locked.
    assert.strictEqual(investigationSpawnGuard(solved, null).state, "ended");
    assert.strictEqual(investigationSpawnGuard(solved, at(3)).state, "ended");
    // A user-authored message after the end unlocks it.
    assert.strictEqual(investigationSpawnGuard(solved, at(5)).state, "open");
    assert.include(
      investigationSpawnRefusal(investigationSpawnGuard(running(), null), "create_threads") ?? "",
      "delegate_task",
    );
    assert.include(
      investigationSpawnRefusal(investigationSpawnGuard(solved, null), "ledger_create") ?? "",
      "until the user sends a new message",
    );
  });
});
