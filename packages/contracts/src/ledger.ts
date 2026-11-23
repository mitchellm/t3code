import * as Schema from "effect/Schema";

import {
  CommandId,
  LedgerCheckpointId,
  LedgerId,
  LedgerItemId,
  NodeId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { LedgerInvestigation, LedgerInvestigationJson } from "./investigation.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** `deferred` is work found out of scope for this task: kept for later, never auto-continued. */
export const LedgerItemStatus = Schema.Literals([
  "open",
  "in_progress",
  "closed",
  "dropped",
  "deferred",
]);
export type LedgerItemStatus = typeof LedgerItemStatus.Type;

/** Who judged, without the provider options a full `ModelSelection` carries. */
export const LedgerVerdictJudge = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type LedgerVerdictJudge = typeof LedgerVerdictJudge.Type;

export const LedgerItemVerdict = Schema.Struct({
  outcome: Schema.Literals(["pass", "fail"]),
  judge: LedgerVerdictJudge,
  notes: Schema.String,
  at: Schema.DateTimeUtc,
  /**
   * Fork: the planner stamps this when it records a verdict on an investigation's approach, the
   * only items judged by the refuter. Only such a pass solves an investigation.
   */
  refuter: Schema.optionalKey(Schema.Boolean),
});
export type LedgerItemVerdict = typeof LedgerItemVerdict.Type;

/** Fork: the delegated task `delegate_task` was given this item for, as it was started. */
export const LedgerItemTaskDraft = Schema.Struct({
  taskId: NodeId,
  childThreadId: ThreadId,
  /** The delegate_task role, absent when the delegation named none. */
  role: Schema.optionalKey(TrimmedNonEmptyString),
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type LedgerItemTaskDraft = typeof LedgerItemTaskDraft.Type;

/**
 * Fork: a delegated task linked to the item it works on. Only the link is stored: its status and
 * final report are read live from the task (the thread's `subagents`, keyed by `taskId`).
 */
export const LedgerItemTask = Schema.Struct({
  ...LedgerItemTaskDraft.fields,
  createdAt: Schema.DateTimeUtc,
});
export type LedgerItemTask = typeof LedgerItemTask.Type;

export const LedgerItemTaskJson = LedgerItemTask.mapFields((fields) => ({
  ...fields,
  createdAt: Schema.DateTimeUtcFromString,
}));

/**
 * Fork: an agent's drop or defer of work it started on a judged ledger. It is a request the judge
 * rules on, like a close, so setting started work aside never waits on the user.
 */
export const LedgerItemSetAside = Schema.Struct({
  status: Schema.Literals(["dropped", "deferred"]),
  reason: TrimmedNonEmptyString,
});
export type LedgerItemSetAside = typeof LedgerItemSetAside.Type;

export const LedgerItem = Schema.Struct({
  id: LedgerItemId,
  title: TrimmedNonEmptyString,
  /** What "done" means for this item; the judge and the harness check against it. */
  acceptance: Schema.String,
  /**
   * Fork: the user's own words this item answers, copied from their message. Present makes the item
   * one of the user's asks: top level only, closed only with proof, never dropped or deferred by an
   * agent, and judged against these words.
   */
  quote: Schema.optionalKey(TrimmedNonEmptyString),
  status: LedgerItemStatus,
  evidence: Schema.NullOr(Schema.String),
  dropReason: Schema.NullOr(Schema.String),
  verdict: Schema.NullOr(LedgerItemVerdict),
  /**
   * Verdicts recorded for this item over its whole life, kept across reopening and new evidence
   * so repeated asking is visible. Absent means none.
   */
  judgements: Schema.optionalKey(NonNegativeInt),
  /**
   * `judgements` when the item was last reopened or last passed, so failures since then are the
   * difference. Absent means zero. Only the planner sets it.
   */
  judgementsAtReopen: Schema.optionalKey(NonNegativeInt),
  /** Items that must be closed or dropped before this one can start or close. Absent means none. */
  blockedBy: Schema.optionalKey(Schema.Array(LedgerItemId)),
  /** The item this one is a sub-item of; a parent cannot close while a child is unfinished. */
  parentItemId: Schema.optionalKey(LedgerItemId),
  /** Why the item was deferred; present only while it is deferred. */
  deferReason: Schema.optionalKey(Schema.String),
  /**
   * The agent asked to close it on a judged ledger and the server's judge is running. Only the
   * server sets or clears it; the verdict closes the item (pass) or hands it back (fail).
   */
  judging: Schema.optionalKey(Schema.Boolean),
  /**
   * Fork: present while judging when the request is a drop or defer rather than a close. A pass
   * sets the item aside with the reason; a fail hands it back in progress.
   */
  setAside: Schema.optionalKey(LedgerItemSetAside),
  /** The delegated judge task for the pending close request, once the server started it. */
  judgeTaskId: Schema.optionalKey(NodeId),
  /**
   * SHA-256 of the prompt the server delegated to `judgeTaskId`. The verdict is checked against
   * it, since a prompt rebuilt at settle can differ (a checkpoint stamped earlier lands later).
   */
  judgePromptDigest: Schema.optionalKey(Schema.String),
  /**
   * Why the last automatic judgement ended without a verdict (the judge could not start or did
   * not finish). Not a failing verdict: the work was never judged.
   */
  judgeError: Schema.optionalKey(Schema.String),
  /** First time the item went in progress, kept across reopening; the judge diffs from here. */
  startedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** Fork: delegated tasks that worked this item, in link order, kept across reopening. */
  tasks: Schema.optionalKey(Schema.Array(LedgerItemTask)),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  closedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type LedgerItem = typeof LedgerItem.Type;

/** Fork: the two model selections of a hand-over, kept whole so the thread can be put back. */
export const LedgerAskCheckHandOverSelections = Schema.Struct({
  from: ModelSelection,
  to: ModelSelection,
});
export type LedgerAskCheckHandOverSelections = typeof LedgerAskCheckHandOverSelections.Type;

/** Fork: which model's thread the stronger checker took over, and when (`Ledger.askCheckHandedOver`). */
export const LedgerAskCheckHandedOver = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  at: Schema.DateTimeUtc,
  /**
   * The thread's own selection and the one it was switched to. The next message from a person puts
   * the thread back on `from` unless they changed it from `to` themselves. Absent on a hand-over
   * recorded before this was kept, which is never undone.
   */
  selections: Schema.optionalKey(LedgerAskCheckHandOverSelections),
});
export type LedgerAskCheckHandedOver = typeof LedgerAskCheckHandedOver.Type;

/** Fork: when the third failed check stopped the ledger, and how many had failed by then. */
export const LedgerAskCheckStopped = Schema.Struct({
  at: Schema.DateTimeUtc,
  fails: NonNegativeInt,
});
export type LedgerAskCheckStopped = typeof LedgerAskCheckStopped.Type;

const LedgerAskCheckHandedOverJson = LedgerAskCheckHandedOver.mapFields((fields) => ({
  ...fields,
  at: Schema.DateTimeUtcFromString,
}));

const LedgerAskCheckStoppedJson = LedgerAskCheckStopped.mapFields((fields) => ({
  ...fields,
  at: Schema.DateTimeUtcFromString,
}));

export const LedgerCheckpoint = Schema.Struct({
  id: LedgerCheckpointId,
  title: TrimmedNonEmptyString,
  reached: Schema.Boolean,
  reachedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type LedgerCheckpoint = typeof LedgerCheckpoint.Type;

export const Ledger = Schema.Struct({
  id: LedgerId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  /** Where the task started, so a later session can tell how far it has moved. */
  startState: Schema.String,
  checkpoints: Schema.Array(LedgerCheckpoint),
  winConditions: Schema.Array(Schema.String),
  items: Schema.Array(LedgerItem),
  /**
   * Items close only on a passing judge verdict. Fixed when the ledger is created under a
   * loadout with a judge role; absent on older records, which means false.
   */
  requiresJudge: Schema.optionalKey(Schema.Boolean),
  /**
   * Fork: the last ask to close is first checked against the user's message by a fresh session on
   * the thread's own model. Fixed when the ledger is created, on a thread with no judge; a ledger
   * has at most one of this and `requiresJudge`. Absent on older records, which means false.
   */
  askCheck: Schema.optionalKey(Schema.Boolean),
  /**
   * Fork: "v2" on an ask check ledger created under the `askCheckPolicy` setting's v2: two tries,
   * then a hand-over to the stronger checker, then a stop. Fixed when the ledger is created, so a
   * setting change never changes a running ledger. Absent means v1, which keeps handing work back.
   */
  askCheckPolicy: Schema.optionalKey(Schema.Literal("v2")),
  /**
   * Failed ask check verdicts recorded on this ledger for the user's current request, whichever
   * item they were on. A reopen does not reset it; a message from a person does. Counted only
   * under v2.
   */
  askCheckFails: Schema.optionalKey(NonNegativeInt),
  /**
   * v2: the thread was handed to the stronger checker's model after the second failed check, for
   * the current request. A person's next message puts the thread back and clears this.
   */
  askCheckHandedOver: Schema.optionalKey(LedgerAskCheckHandedOver),
  /**
   * v2: the third failed check stopped the ledger. The held item stays in progress, is never
   * checked again and cannot be closed by the agent until the user writes, which also gives the
   * next request a fresh budget.
   */
  askCheckStopped: Schema.optionalKey(LedgerAskCheckStopped),
  /** Fork: present when the ledger runs an investigation (Investigate mode). */
  investigation: Schema.optionalKey(LedgerInvestigation),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  closedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type Ledger = typeof Ledger.Type;

/**
 * The ledger as a thread list needs it. Dropped items are out of `total`, and a ledger with
 * nothing left to measure has no summary at all.
 */
export const LedgerProgress = Schema.Struct({
  closed: NonNegativeInt,
  open: NonNegativeInt,
  total: NonNegativeInt,
});
export type LedgerProgress = typeof LedgerProgress.Type;

export const LedgerItemVerdictJson = LedgerItemVerdict.mapFields((fields) => ({
  ...fields,
  at: Schema.DateTimeUtcFromString,
}));

export const LedgerItemJson = LedgerItem.mapFields((fields) => ({
  ...fields,
  verdict: Schema.NullOr(LedgerItemVerdictJson),
  startedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  tasks: Schema.optionalKey(Schema.Array(LedgerItemTaskJson)),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  closedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

export const LedgerCheckpointJson = LedgerCheckpoint.mapFields((fields) => ({
  ...fields,
  reachedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

export const LedgerJson = Ledger.mapFields((fields) => ({
  ...fields,
  checkpoints: Schema.Array(LedgerCheckpointJson),
  items: Schema.Array(LedgerItemJson),
  askCheckHandedOver: Schema.optionalKey(LedgerAskCheckHandedOverJson),
  askCheckStopped: Schema.optionalKey(LedgerAskCheckStoppedJson),
  investigation: Schema.optionalKey(LedgerInvestigationJson),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  closedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}));

/** Item fields a client supplies when adding; the server stamps status and times. */
export const LedgerItemDraft = Schema.Struct({
  id: LedgerItemId,
  title: TrimmedNonEmptyString,
  acceptance: Schema.String,
  /** Fork: the user's words this item answers; see `LedgerItem.quote`. */
  quote: Schema.optionalKey(TrimmedNonEmptyString),
  blockedBy: Schema.optionalKey(Schema.Array(LedgerItemId)),
  parentItemId: Schema.optionalKey(LedgerItemId),
  /** Present means the item starts deferred, for out-of-scope work recorded for later. */
  deferReason: Schema.optionalKey(Schema.String),
});
export type LedgerItemDraft = typeof LedgerItemDraft.Type;

export const LedgerCheckpointDraft = Schema.Struct({
  id: LedgerCheckpointId,
  title: TrimmedNonEmptyString,
});
export type LedgerCheckpointDraft = typeof LedgerCheckpointDraft.Type;

/** Who sent a ledger command: absent means the user, as a client sends it. */
const LedgerActor = Schema.Literals(["user", "agent"]);

export const LedgerCommands = [
  Schema.Struct({
    type: Schema.Literal("ledger.create"),
    commandId: CommandId,
    threadId: ThreadId,
    ledgerId: LedgerId,
    title: TrimmedNonEmptyString,
    startState: Schema.String,
    checkpoints: Schema.Array(LedgerCheckpointDraft),
    winConditions: Schema.Array(Schema.String),
    // No requiresJudge or askCheck: the orchestrator derives them from the thread's loadout and
    // settings, so neither a client nor the agent being judged can opt a ledger out of the gate.
    items: Schema.Array(LedgerItemDraft),
    /** As on `ledger.item.update`: the ledger tools stamp "agent", which only narrows. */
    createdBy: Schema.optional(LedgerActor),
  }),
  Schema.Struct({
    type: Schema.Literal("ledger.item.add"),
    commandId: CommandId,
    threadId: ThreadId,
    ledgerId: LedgerId,
    items: Schema.Array(LedgerItemDraft),
  }),
  Schema.Struct({
    type: Schema.Literal("ledger.item.update"),
    commandId: CommandId,
    threadId: ThreadId,
    ledgerId: LedgerId,
    itemId: LedgerItemId,
    status: Schema.optional(LedgerItemStatus),
    evidence: Schema.optional(Schema.NullOr(Schema.String)),
    dropReason: Schema.optional(Schema.NullOr(Schema.String)),
    deferReason: Schema.optional(Schema.NullOr(Schema.String)),
    /** Replaces the whole blocker list; an empty array clears it. */
    blockedBy: Schema.optional(Schema.Array(LedgerItemId)),
    /** Null moves the item to the top level. */
    parentItemId: Schema.optional(Schema.NullOr(LedgerItemId)),
    /**
     * The ledger MCP tools stamp "agent"; a client sends nothing, which means the user. Claiming
     * "agent" only narrows what the command may do, so a client gains nothing by it.
     */
    createdBy: Schema.optional(Schema.Literals(["user", "agent"])),
    // No verdict and no judging flag: only the server attests a verdict, via the internal
    // `ledger.item.verdict.record`, and only the planner starts a judgement.
  }).check(
    Schema.makeFilter(
      (update) =>
        update.status !== undefined ||
        update.evidence !== undefined ||
        update.dropReason !== undefined ||
        update.deferReason !== undefined ||
        update.blockedBy !== undefined ||
        update.parentItemId !== undefined ||
        "A ledger item update must change status, evidence, a reason, blockedBy or parentItemId.",
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("ledger.checkpoint.set"),
    commandId: CommandId,
    threadId: ThreadId,
    ledgerId: LedgerId,
    checkpointId: LedgerCheckpointId,
    reached: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("ledger.close"),
    commandId: CommandId,
    threadId: ThreadId,
    ledgerId: LedgerId,
    createdBy: Schema.optional(LedgerActor),
  }),
  Schema.Struct({
    type: Schema.Literal("ledger.reopen"),
    commandId: CommandId,
    threadId: ThreadId,
    ledgerId: LedgerId,
    createdBy: Schema.optional(LedgerActor),
  }),
] as const;

/** Server-only: keeps a judge verdict from being asserted by a client. */
export const LedgerVerdictRecordCommand = Schema.Struct({
  type: Schema.Literal("ledger.item.verdict.record"),
  commandId: CommandId,
  threadId: ThreadId,
  ledgerId: LedgerId,
  itemId: LedgerItemId,
  verdict: LedgerItemVerdict,
  /**
   * v2 ask check: the thread was just switched from `from` to `to`, the stronger checker's model.
   * The planner records it only when this verdict is the ledger's second failed check.
   */
  handOver: Schema.optionalKey(Schema.Struct({ from: Schema.String, to: Schema.String })),
  /** The whole selections behind `handOver`, recorded with it. */
  handOverSelections: Schema.optionalKey(LedgerAskCheckHandOverSelections),
  /** The evidence the judge was shown; a verdict for evidence that has since changed is stale. */
  judgedEvidence: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * The close request this verdict answers (the judging item's `updatedAt`). With it the verdict
   * settles that request, and is ignored once a newer request or a settlement replaced it.
   * Without it the verdict only records, as an explicit judgement does.
   */
  judgingRequestedAt: Schema.optionalKey(Schema.DateTimeUtc),
});

/** Server-only: ends an automatic judgement that produced no verdict, handing the item back. */
export const LedgerJudgementAbandonCommand = Schema.Struct({
  type: Schema.Literal("ledger.item.judgement.abandon"),
  commandId: CommandId,
  threadId: ThreadId,
  ledgerId: LedgerId,
  itemId: LedgerItemId,
  reason: TrimmedNonEmptyString,
});

/** Server-only: records the judge task a pending close request started. */
export const LedgerJudgementStartedCommand = Schema.Struct({
  type: Schema.Literal("ledger.item.judgement.started"),
  commandId: CommandId,
  threadId: ThreadId,
  ledgerId: LedgerId,
  itemId: LedgerItemId,
  /** The item's `updatedAt` when the close request made it judging; a later request is stale. */
  requestedAt: Schema.DateTimeUtc,
  taskId: NodeId,
  /** SHA-256 of the prompt delegated to `taskId`. */
  promptDigest: Schema.String,
});

/**
 * Fork, server-only: links a task delegate_task started to the item it works on. Only the server
 * sends it, after the delegation, so no client can attach work that never ran.
 */
export const LedgerItemTaskLinkCommand = Schema.Struct({
  type: Schema.Literal("ledger.item.task.link"),
  commandId: CommandId,
  threadId: ThreadId,
  ledgerId: LedgerId,
  itemId: LedgerItemId,
  task: LedgerItemTaskDraft,
});

/**
 * Server-only: a person wrote, which starts a new request. A v2 ledger's ask check record (the
 * failed checks, the hand-over and the stop) is cleared, so the check has its whole budget again
 * whether the agent writes a new ledger or goes on with this one. Sent when a person's message
 * arrives; plans nothing while the record is empty.
 */
export const LedgerAskCheckResumeCommand = Schema.Struct({
  type: Schema.Literal("ledger.ask-check.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  ledgerId: LedgerId,
});

/**
 * Payload of `ledger.ask-check.updated`: the whole v2 ask check record after a change, so a reader
 * replaces its own. An absent `handedOver` or `stopped` means there is none.
 */
export const LedgerAskCheckUpdatedPayload = Schema.Struct({
  ledgerId: LedgerId,
  fails: NonNegativeInt,
  handedOver: Schema.optionalKey(LedgerAskCheckHandedOver),
  stopped: Schema.optionalKey(LedgerAskCheckStopped),
  updatedAt: Schema.DateTimeUtc,
});
export type LedgerAskCheckUpdatedPayload = typeof LedgerAskCheckUpdatedPayload.Type;

export const LedgerAskCheckUpdatedPayloadJson = LedgerAskCheckUpdatedPayload.mapFields(
  (fields) => ({
    ...fields,
    handedOver: Schema.optionalKey(LedgerAskCheckHandedOverJson),
    stopped: Schema.optionalKey(LedgerAskCheckStoppedJson),
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

/** Payload of `ledger.item.added`: only the newly added items, which readers upsert. */
export const LedgerItemsAddedPayload = Schema.Struct({
  ledgerId: LedgerId,
  items: Schema.Array(LedgerItem),
  updatedAt: Schema.DateTimeUtc,
});
export type LedgerItemsAddedPayload = typeof LedgerItemsAddedPayload.Type;

export const LedgerItemsAddedPayloadJson = LedgerItemsAddedPayload.mapFields((fields) => ({
  ...fields,
  items: Schema.Array(LedgerItemJson),
  updatedAt: Schema.DateTimeUtcFromString,
}));

/** Payload of `ledger.item.updated`: the one item after the change. */
export const LedgerItemUpdatedPayload = Schema.Struct({
  ledgerId: LedgerId,
  item: LedgerItem,
  updatedAt: Schema.DateTimeUtc,
});
export type LedgerItemUpdatedPayload = typeof LedgerItemUpdatedPayload.Type;

export const LedgerItemUpdatedPayloadJson = LedgerItemUpdatedPayload.mapFields((fields) => ({
  ...fields,
  item: LedgerItemJson,
  updatedAt: Schema.DateTimeUtcFromString,
}));

export const LedgerCheckpointUpdatedPayload = Schema.Struct({
  ledgerId: LedgerId,
  checkpoint: LedgerCheckpoint,
  updatedAt: Schema.DateTimeUtc,
});
export type LedgerCheckpointUpdatedPayload = typeof LedgerCheckpointUpdatedPayload.Type;

export const LedgerCheckpointUpdatedPayloadJson = LedgerCheckpointUpdatedPayload.mapFields(
  (fields) => ({
    ...fields,
    checkpoint: LedgerCheckpointJson,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
);

export const LedgerClosedPayload = Schema.Struct({
  ledgerId: LedgerId,
  closedAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type LedgerClosedPayload = typeof LedgerClosedPayload.Type;

export const LedgerClosedPayloadJson = LedgerClosedPayload.mapFields((fields) => ({
  ...fields,
  closedAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
}));

export const LedgerReopenedPayload = Schema.Struct({
  ledgerId: LedgerId,
  updatedAt: Schema.DateTimeUtc,
});
export type LedgerReopenedPayload = typeof LedgerReopenedPayload.Type;

export const LedgerReopenedPayloadJson = LedgerReopenedPayload.mapFields((fields) => ({
  ...fields,
  updatedAt: Schema.DateTimeUtcFromString,
}));
