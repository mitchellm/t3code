import type {
  Ledger,
  LedgerCheckpoint,
  LedgerItem,
  LedgerItemDraft,
  LedgerItemStatus,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2InternalCommand,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

export type LedgerEventBody = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: `ledger.${string}` }
>;

/** A ledger event before the orchestrator stamps its id, thread and provider instance. */
export type PlannedLedgerEvent = {
  [Type in LedgerEventBody["type"]]: {
    readonly type: Type;
    readonly payload: Extract<LedgerEventBody, { readonly type: Type }>["payload"];
  };
}[LedgerEventBody["type"]];

type WithoutId<Event> = Event extends unknown ? Omit<Event, "id"> : never;

/**
 * Stamps a planned event with the thread envelope. One branch per type keeps each `type`
 * paired with its own payload, which spreading the union would not.
 */
export function ledgerEventFromPlan(
  planned: PlannedLedgerEvent,
  envelope: {
    readonly threadId: LedgerEventBody["threadId"];
    readonly providerInstanceId: ProviderInstanceId;
    readonly occurredAt: DateTime.Utc;
  },
): WithoutId<LedgerEventBody> {
  switch (planned.type) {
    case "ledger.created":
      return { ...envelope, type: planned.type, payload: planned.payload };
    case "ledger.item.added":
      return { ...envelope, type: planned.type, payload: planned.payload };
    case "ledger.item.updated":
      return { ...envelope, type: planned.type, payload: planned.payload };
    case "ledger.checkpoint.updated":
      return { ...envelope, type: planned.type, payload: planned.payload };
    case "ledger.closed":
      return { ...envelope, type: planned.type, payload: planned.payload };
    case "ledger.reopened":
      return { ...envelope, type: planned.type, payload: planned.payload };
  }
}

export type LedgerCommand = Extract<
  OrchestrationV2Command | OrchestrationV2InternalCommand,
  { readonly type: `ledger.${string}` }
>;

/** Plain text because the orchestrator surfaces it as the dispatch error's cause, like its siblings. */
export type LedgerRejection = string;

/**
 * The one transition table. Items start, finish, drop and defer; an in-progress item can be
 * un-started; a closed, dropped or deferred item comes back as open. An open item may close
 * directly so a small item finishes in one step, but closing still needs evidence.
 */
const LEGAL_TRANSITIONS: Readonly<Record<LedgerItemStatus, ReadonlyArray<LedgerItemStatus>>> = {
  open: ["in_progress", "closed", "dropped", "deferred"],
  in_progress: ["open", "closed", "dropped", "deferred"],
  closed: ["open"],
  dropped: ["open"],
  deferred: ["open", "dropped"],
};

const isBlank = (text: string | null | undefined) =>
  text === null || text === undefined || text.trim() === "";

/** Open or in progress: what keeps a ledger, a parent or a blocked item from finishing. */
const isUnfinished = (item: Pick<LedgerItem, "status">) =>
  item.status === "open" || item.status === "in_progress";

/** A blocker releases its dependents once it is closed or dropped; deferred still blocks. */
const releasesDependents = (item: Pick<LedgerItem, "status">) =>
  item.status === "closed" || item.status === "dropped";

function duplicateId(ids: ReadonlyArray<string>): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function newItem(draft: LedgerItemDraft, now: DateTime.Utc): LedgerItem {
  return {
    id: draft.id,
    title: draft.title,
    acceptance: draft.acceptance,
    status: draft.deferReason === undefined ? "open" : "deferred",
    evidence: null,
    dropReason: null,
    verdict: null,
    ...(draft.blockedBy === undefined || draft.blockedBy.length === 0
      ? {}
      : { blockedBy: draft.blockedBy }),
    ...(draft.parentItemId === undefined ? {} : { parentItemId: draft.parentItemId }),
    ...(draft.deferReason === undefined ? {} : { deferReason: draft.deferReason }),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}

/** Drops an optional key rather than storing it empty, so stored items stay as small as before. */
function withOptional<
  Key extends
    | "blockedBy"
    | "parentItemId"
    | "deferReason"
    | "judging"
    | "judgeTaskId"
    | "judgeError",
>(item: LedgerItem, key: Key, value: LedgerItem[Key] | undefined): LedgerItem {
  // Only optional keys are accepted, so the item stays a complete LedgerItem either way.
  const { [key]: _removed, ...rest } = item;
  return (value === undefined ? rest : { ...rest, [key]: value }) as LedgerItem;
}

/**
 * Checks the dependency and parent graphs of a whole item list: every reference names a known
 * item, nothing references itself, and neither graph has a cycle. Linear in items plus edges,
 * because ledgers reach thousands of items.
 */
function structureProblem(items: ReadonlyArray<LedgerItem>): string | undefined {
  const byId = new Map(items.map((item) => [item.id as string, item]));
  for (const item of items) {
    for (const blocker of item.blockedBy ?? []) {
      if (blocker === item.id) return `Item ${item.id} cannot be blocked by itself.`;
      if (!byId.has(blocker)) return `Item ${item.id} is blocked by unknown item ${blocker}.`;
    }
    if (item.parentItemId !== undefined) {
      if (item.parentItemId === item.id) return `Item ${item.id} cannot be a sub-item of itself.`;
      if (!byId.has(item.parentItemId)) {
        return `Item ${item.id} has unknown parent item ${item.parentItemId}.`;
      }
    }
  }
  // Iterative three-colour DFS over blockedBy, so a long chain cannot overflow the stack.
  const state = new Map<string, "visiting" | "done">();
  for (const start of items) {
    if (state.has(start.id)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start.id, next: 0 }];
    state.set(start.id, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const blockers = byId.get(frame.id)?.blockedBy ?? [];
      if (frame.next >= blockers.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const blocker = blockers[frame.next]!;
      frame.next += 1;
      const seen = state.get(blocker);
      if (seen === "visiting") {
        return `Blockers form a cycle through ${blocker} and ${frame.id}.`;
      }
      if (seen === undefined) {
        state.set(blocker, "visiting");
        stack.push({ id: blocker, next: 0 });
      }
    }
  }
  // Each parent chain is walked once; a chain that reaches a checked item stops there.
  const rooted = new Set<string>();
  for (const start of items) {
    const chain = new Set<string>();
    let current: LedgerItem | undefined = start;
    while (current !== undefined && !rooted.has(current.id)) {
      if (chain.has(current.id)) return `Parent items form a cycle through ${current.id}.`;
      chain.add(current.id);
      current = current.parentItemId === undefined ? undefined : byId.get(current.parentItemId);
    }
    for (const id of chain) rooted.add(id);
  }
  return undefined;
}

/**
 * Placement checks for items being added or changed: a child that still has work cannot sit under
 * a closed parent, and unfinished work cannot wait on a deferred item, which never finishes in
 * this task.
 */
function placementProblem(
  items: ReadonlyArray<LedgerItem>,
  changed: ReadonlyArray<LedgerItem>,
): string | undefined {
  const byId = new Map(items.map((item) => [item.id as string, item]));
  for (const item of changed) {
    if (!isUnfinished(item)) continue;
    const parent = item.parentItemId === undefined ? undefined : byId.get(item.parentItemId);
    if (parent?.status === "closed") {
      return `Parent item ${parent.id} is closed. Reopen it before giving it unfinished sub-items.`;
    }
    const deferred = (item.blockedBy ?? []).find((id) => byId.get(id)?.status === "deferred");
    if (deferred !== undefined) {
      return `Item ${item.id} cannot wait on ${deferred}, which is deferred. Drop the dependency or defer ${item.id} too.`;
    }
  }
  return undefined;
}

/** Deferring an item that unfinished work waits on would block that work for good. */
function dependentsOf(ledger: Ledger, item: LedgerItem): ReadonlyArray<LedgerItem> {
  return ledger.items.filter(
    (candidate) => isUnfinished(candidate) && (candidate.blockedBy ?? []).includes(item.id),
  );
}

function draftProblem(drafts: ReadonlyArray<LedgerItemDraft>): string | undefined {
  const blank = drafts.find(
    (draft) => draft.deferReason !== undefined && isBlank(draft.deferReason),
  );
  return blank === undefined
    ? undefined
    : `Item ${blank.id} needs a non-empty deferReason to start deferred.`;
}

function blockersOf(ledger: Ledger, item: LedgerItem): ReadonlyArray<LedgerItem> {
  if (item.blockedBy === undefined || item.blockedBy.length === 0) return [];
  const blockers = new Set<string>(item.blockedBy);
  return ledger.items.filter(
    (candidate) => blockers.has(candidate.id) && !releasesDependents(candidate),
  );
}

const describeItems = (items: ReadonlyArray<LedgerItem>) =>
  items.map((item) => `${item.id} (${item.status})`).join(", ");

/**
 * `requiresJudge` defaults to the ledger's own field so no caller can forget the gate; a close
 * without a passing verdict becomes a judgement in progress. For `ledger.create` it is the value
 * to stamp. A command that changes nothing plans no events, so a retry does not bump `updatedAt`.
 */
export function planLedgerCommand(input: {
  readonly command: LedgerCommand;
  readonly ledger: Ledger | undefined;
  readonly now: DateTime.Utc;
  readonly requiresJudge?: boolean;
}): Result.Result<ReadonlyArray<PlannedLedgerEvent>, LedgerRejection> {
  const { command, ledger, now } = input;
  const requiresJudge = input.requiresJudge ?? ledger?.requiresJudge ?? false;
  const reject = (detail: string) => Result.fail(detail);

  if (command.type === "ledger.create") {
    if (ledger !== undefined && ledger.closedAt === null) {
      return reject(
        `Thread ${command.threadId} already has an open ledger (${ledger.id}). Close it before creating another.`,
      );
    }
    if (ledger?.id === command.ledgerId) {
      return reject(
        `Ledger id ${command.ledgerId} is already used by this thread's closed ledger.`,
      );
    }
    const duplicateItem = duplicateId(command.items.map((item) => item.id));
    if (duplicateItem !== undefined) return reject(`Duplicate item id ${duplicateItem}.`);
    const duplicateCheckpoint = duplicateId(command.checkpoints.map((checkpoint) => checkpoint.id));
    if (duplicateCheckpoint !== undefined) {
      return reject(`Duplicate checkpoint id ${duplicateCheckpoint}.`);
    }
    const createdItems = command.items.map((draft) => newItem(draft, now));
    const createProblem =
      draftProblem(command.items) ??
      structureProblem(createdItems) ??
      placementProblem(createdItems, createdItems);
    if (createProblem !== undefined) return reject(createProblem);
    // A closed ledger's flag must not leak into its replacement, so only the input counts here.
    const stampedRequiresJudge = input.requiresJudge === true;
    return Result.succeed([
      {
        type: "ledger.created",
        payload: {
          id: command.ledgerId,
          threadId: command.threadId,
          title: command.title,
          startState: command.startState,
          checkpoints: command.checkpoints.map((checkpoint): LedgerCheckpoint => ({
            id: checkpoint.id,
            title: checkpoint.title,
            reached: false,
            reachedAt: null,
          })),
          winConditions: command.winConditions,
          items: createdItems,
          ...(stampedRequiresJudge ? { requiresJudge: true } : {}),
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        },
      },
    ]);
  }

  if (ledger === undefined) return reject(`Thread ${command.threadId} has no ledger.`);
  if (ledger.id !== command.ledgerId) {
    return reject(`Unknown ledger ${command.ledgerId}; the thread's ledger is ${ledger.id}.`);
  }

  if (command.type === "ledger.reopen") {
    if (ledger.closedAt === null) return reject(`Ledger ${ledger.id} is not closed.`);
    return Result.succeed([
      { type: "ledger.reopened", payload: { ledgerId: ledger.id, updatedAt: now } },
    ]);
  }

  // Everything below edits the ledger, which a closed ledger refuses until it is reopened.
  if (ledger.closedAt !== null) {
    return reject(
      command.type === "ledger.close"
        ? `Ledger ${ledger.id} is already closed.`
        : `Ledger ${ledger.id} is closed. Reopen it before changing it.`,
    );
  }

  switch (command.type) {
    case "ledger.close": {
      // Deferred items are kept for later and do not hold the task open.
      const unfinished = ledger.items.filter(isUnfinished);
      if (unfinished.length > 0) {
        return reject(
          `Ledger ${ledger.id} cannot close: items still open or in progress: ${unfinished.map((item) => item.id).join(", ")}. Close or drop them first.`,
        );
      }
      return Result.succeed([
        { type: "ledger.closed", payload: { ledgerId: ledger.id, closedAt: now, updatedAt: now } },
      ]);
    }
    case "ledger.item.add": {
      if (command.items.length === 0) return reject("Add at least one item.");
      const duplicate = duplicateId([
        ...ledger.items.map((item) => item.id),
        ...command.items.map((item) => item.id),
      ]);
      if (duplicate !== undefined) return reject(`Duplicate item id ${duplicate}.`);
      const added = command.items.map((draft) => newItem(draft, now));
      const all = [...ledger.items, ...added];
      const addProblem =
        draftProblem(command.items) ?? structureProblem(all) ?? placementProblem(all, added);
      if (addProblem !== undefined) return reject(addProblem);
      return Result.succeed([
        {
          type: "ledger.item.added",
          payload: { ledgerId: ledger.id, items: added, updatedAt: now },
        },
      ]);
    }
    case "ledger.checkpoint.set": {
      const checkpoint = ledger.checkpoints.find(({ id }) => id === command.checkpointId);
      if (checkpoint === undefined) return reject(`Unknown checkpoint ${command.checkpointId}.`);
      if (checkpoint.reached === command.reached) return Result.succeed([]);
      return Result.succeed([
        {
          type: "ledger.checkpoint.updated",
          payload: {
            ledgerId: ledger.id,
            checkpoint: {
              ...checkpoint,
              reached: command.reached,
              reachedAt: command.reached ? now : null,
            },
            updatedAt: now,
          },
        },
      ]);
    }
    case "ledger.item.verdict.record": {
      const item = ledger.items.find(({ id }) => id === command.itemId);
      if (item === undefined) return reject(`Unknown item ${command.itemId}.`);
      if (item.status === "closed" || item.status === "dropped" || item.status === "deferred") {
        return reject(`Item ${item.id} is ${item.status}. Reopen it before judging it.`);
      }
      if (command.judgedEvidence !== undefined && command.judgedEvidence !== item.evidence) {
        return reject(`Item ${item.id} evidence changed while it was being judged.`);
      }
      const recorded: LedgerItem = {
        ...item,
        verdict: command.verdict,
        judgements: (item.judgements ?? 0) + 1,
        updatedAt: now,
      };
      // Without a pending close request a verdict only unlocks closing; the agent closes it.
      if (item.judging !== true) return itemUpdated(ledger.id, recorded, now);
      const settled = withOptional(endJudging(recorded), "judgeError", undefined);
      // A blocker or sub-item reopened while the judge ran: keep the pass, leave the close to
      // the agent, whose next close request then succeeds without another judge.
      const closes =
        command.verdict.outcome === "pass" &&
        blockersOf(ledger, item).length === 0 &&
        unfinishedChildren(ledger, item).length === 0;
      return itemUpdated(
        ledger.id,
        closes
          ? { ...settled, status: "closed", closedAt: now }
          : { ...settled, status: "in_progress" },
        now,
      );
    }
    case "ledger.item.judgement.abandon": {
      const item = ledger.items.find(({ id }) => id === command.itemId);
      if (item === undefined) return reject(`Unknown item ${command.itemId}.`);
      // A verdict or a drop already ended the judgement; a late abandon changes nothing.
      if (item.judging !== true) return Result.succeed([]);
      return itemUpdated(
        ledger.id,
        withOptional({ ...endJudging(item), updatedAt: now }, "judgeError", command.reason),
        now,
      );
    }
    case "ledger.item.judgement.started": {
      const item = ledger.items.find(({ id }) => id === command.itemId);
      if (item === undefined) return reject(`Unknown item ${command.itemId}.`);
      // Only the request that started this judge may claim it; a settled or newer one ignores it.
      const current =
        item.judging === true &&
        DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(command.requestedAt);
      if (!current || item.judgeTaskId === command.taskId) return Result.succeed([]);
      // `updatedAt` stays the request's stamp, which keys the judge's effects and delegation.
      return itemUpdated(ledger.id, { ...item, judgeTaskId: command.taskId }, now);
    }
    case "ledger.item.update": {
      const item = ledger.items.find(({ id }) => id === command.itemId);
      if (item === undefined) return reject(`Unknown item ${command.itemId}.`);
      if (item.judging === true) {
        const repeatsClose =
          command.status === "closed" &&
          (command.evidence === undefined || command.evidence === item.evidence) &&
          command.dropReason === undefined &&
          command.deferReason === undefined &&
          command.blockedBy === undefined &&
          command.parentItemId === undefined;
        // A retried close request while the judge runs is already in effect.
        if (repeatsClose) return Result.succeed([]);
        if (command.status !== "dropped") {
          return reject(
            `Item ${item.id} is being judged. Wait for the verdict, which closes it or hands it back with the judge's notes.`,
          );
        }
      }
      const target = command.status ?? item.status;
      const changesStatus = target !== item.status;

      if (changesStatus && !LEGAL_TRANSITIONS[item.status].includes(target)) {
        return reject(`Item ${item.id} cannot go from ${item.status} to ${target}.`);
      }
      // On a judged ledger, work the agent started ends only through the judge; setting it aside
      // is the user's call. Deferring or dropping work it never started stays open to it.
      if (
        command.createdBy === "agent" &&
        requiresJudge &&
        changesStatus &&
        item.status === "in_progress" &&
        (target === "deferred" || target === "dropped" || target === "open")
      ) {
        return reject(
          `Item ${item.id} is in progress on a judged ledger. Close it with evidence for the judge, or ask the user to defer or drop it.`,
        );
      }
      if (changesStatus && target === "deferred") {
        const dependents = dependentsOf(ledger, item);
        if (dependents.length > 0) {
          return reject(
            `Item ${item.id} cannot be deferred while unfinished items wait on it: ${describeItems(dependents)}. Defer them first or drop the dependency.`,
          );
        }
      }
      if (!changesStatus && (item.status === "closed" || item.status === "dropped")) {
        return reject(`Item ${item.id} is ${item.status}. Reopen it to change it.`);
      }

      let structured: LedgerItem = item;
      if (command.blockedBy !== undefined) {
        structured = withOptional(
          structured,
          "blockedBy",
          command.blockedBy.length === 0 ? undefined : command.blockedBy,
        );
      }
      if (command.parentItemId !== undefined) {
        structured = withOptional(structured, "parentItemId", command.parentItemId ?? undefined);
      }
      const changesStructure =
        JSON.stringify(structured.blockedBy ?? []) !== JSON.stringify(item.blockedBy ?? []) ||
        structured.parentItemId !== item.parentItemId;
      if (changesStructure) {
        const items = ledger.items.map((candidate) =>
          candidate.id === item.id ? structured : candidate,
        );
        const problem = structureProblem(items) ?? placementProblem(items, [structured]);
        if (problem !== undefined) return reject(problem);
      }

      // Reopening a finished item starts it over; un-starting an in-progress item or reviving a
      // deferred one only changes its status and keeps the evidence gathered so far.
      if (target === "open" && changesStatus && item.status !== "in_progress") {
        if (
          command.evidence !== undefined ||
          (command.dropReason !== undefined && command.dropReason !== null) ||
          (command.deferReason !== undefined && command.deferReason !== null)
        ) {
          return reject("Reopening an item clears its evidence and reasons; do not supply them.");
        }
        const revived = withOptional(
          withOptional(structured, "deferReason", undefined),
          "judgeError",
          undefined,
        );
        return itemUpdated(
          ledger.id,
          item.status === "deferred"
            ? { ...revived, status: "open", updatedAt: now }
            : {
                ...revived,
                status: "open",
                evidence: null,
                dropReason: null,
                verdict: null,
                closedAt: null,
                updatedAt: now,
              },
          now,
        );
      }

      const evidence = command.evidence === undefined ? item.evidence : command.evidence;
      const dropReason = command.dropReason === undefined ? item.dropReason : command.dropReason;
      const deferReason =
        command.deferReason === undefined ? item.deferReason : (command.deferReason ?? undefined);
      // Skipping in_progress is allowed only when the same update brings the evidence.
      if (target === "closed" && item.status === "open" && isBlank(command.evidence)) {
        return reject(`Item ${item.id} needs evidence in the same update to close from open.`);
      }
      if (target === "closed" && isBlank(evidence)) {
        return reject(`Item ${item.id} needs non-empty evidence to close.`);
      }
      if (target === "dropped" && isBlank(dropReason)) {
        return reject(`Item ${item.id} needs a non-empty dropReason to be dropped.`);
      }
      if (target !== "dropped" && command.dropReason !== undefined && command.dropReason !== null) {
        return reject("A dropReason only applies when dropping an item.");
      }
      if (target === "deferred" && isBlank(deferReason)) {
        return reject(`Item ${item.id} needs a non-empty deferReason to be deferred.`);
      }
      if (
        target !== "deferred" &&
        command.deferReason !== undefined &&
        command.deferReason !== null
      ) {
        return reject("A deferReason only applies when deferring an item.");
      }
      if (changesStatus && (target === "in_progress" || target === "closed")) {
        const blockers = blockersOf(ledger, structured);
        if (blockers.length > 0) {
          return reject(
            `Item ${item.id} is blocked by ${describeItems(blockers)}. Close or drop them first.`,
          );
        }
      }
      if (changesStatus && target === "closed") {
        const children = unfinishedChildren(ledger, item);
        if (children.length > 0) {
          return reject(
            `Item ${item.id} has unfinished sub-items: ${describeItems(children)}. Close, drop or defer them first.`,
          );
        }
      }
      // A verdict judged the evidence as it stood, so changed evidence needs a fresh one;
      // otherwise pass, edit the evidence, close would sidestep the judge gate.
      const verdict = evidence === item.evidence ? item.verdict : null;
      if (target === "closed" && requiresJudge && verdict?.outcome !== "pass") {
        // The close becomes a request: the server's judge runs and its verdict settles it, so
        // the agent never has to ask, and cannot close past it.
        return itemUpdated(
          ledger.id,
          {
            ...withOptional(
              withOptional(endJudging(structured), "deferReason", undefined),
              "judgeError",
              undefined,
            ),
            status: "in_progress",
            evidence,
            dropReason: null,
            verdict: null,
            judging: true,
            closedAt: null,
            updatedAt: now,
          },
          now,
        );
      }

      // A closed or dropped item never reaches here without changing status, so `closedAt` is
      // only ever stamped by the transition into closed.
      let next: LedgerItem = {
        ...structured,
        status: target,
        evidence,
        dropReason: target === "dropped" ? dropReason : null,
        verdict,
        closedAt: target === "closed" ? now : null,
        updatedAt: now,
      };
      next = withOptional(next, "deferReason", target === "deferred" ? deferReason : undefined);
      if (target === "dropped") next = endJudging(next);
      if (changesStatus || evidence !== item.evidence) {
        next = withOptional(next, "judgeError", undefined);
      }
      if (
        !changesStatus &&
        !changesStructure &&
        evidence === item.evidence &&
        next.dropReason === item.dropReason &&
        next.deferReason === item.deferReason
      ) {
        return Result.succeed([]);
      }
      return itemUpdated(ledger.id, next, now);
    }
  }
}

const endJudging = (item: LedgerItem): LedgerItem =>
  withOptional(withOptional(item, "judging", undefined), "judgeTaskId", undefined);

/**
 * The judge each newly judging item needs, committed with the event that made it judging, so a
 * close from any client starts one and a crash before it runs leaves it in the outbox. Keyed by
 * ledger, item and request stamp: a replay is the same effect and the same delegation.
 */
export function ledgerJudgeEffects(
  command: LedgerCommand,
  ledger: Ledger | undefined,
  planned: ReadonlyArray<PlannedLedgerEvent>,
): ReadonlyArray<PendingOrchestrationEffectV2> {
  return planned.flatMap((event) => {
    if (event.type !== "ledger.item.updated" || event.payload.item.judging !== true) return [];
    const { item } = event.payload;
    const before = ledger?.items.find(({ id }) => id === item.id);
    if (before?.judging === true) return [];
    const requestedAt = DateTime.formatIso(item.updatedAt);
    return [
      {
        id: `effect:ledger-judge:${event.payload.ledgerId}:${item.id}:${requestedAt}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "ledger-judge.start",
          ledgerId: event.payload.ledgerId,
          itemId: item.id,
          requestedAt,
        },
      },
    ];
  });
}

function unfinishedChildren(ledger: Ledger, parent: LedgerItem): ReadonlyArray<LedgerItem> {
  return ledger.items.filter((item) => item.parentItemId === parent.id && isUnfinished(item));
}

function itemUpdated(
  ledgerId: Ledger["id"],
  item: LedgerItem,
  now: DateTime.Utc,
): Result.Result<ReadonlyArray<PlannedLedgerEvent>, LedgerRejection> {
  return Result.succeed([
    { type: "ledger.item.updated", payload: { ledgerId, item, updatedAt: now } },
  ]);
}
