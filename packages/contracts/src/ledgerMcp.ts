import * as Schema from "effect/Schema";

import {
  LedgerCheckpointId,
  LedgerItemId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { LedgerItemSetAside, LedgerItemStatus } from "./ledger.ts";
import { OrchestrationV2Subagent } from "./orchestrationV2.ts";

// Agents pick these keys by hand and read them back in every tool result, so keep them short.
const SHORT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const LedgerMcpItemKey = LedgerItemId.check(
  Schema.isMaxLength(32),
  Schema.isPattern(SHORT_KEY),
).annotate({
  description: 'Short unique item key you choose, such as "L1": letters, digits, ".", "_", "-".',
});
export const LedgerMcpCheckpointKey = LedgerCheckpointId.check(
  Schema.isMaxLength(32),
  Schema.isPattern(SHORT_KEY),
).annotate({
  description:
    'Short unique checkpoint key you choose, such as "C1": letters, digits, ".", "_", "-".',
});

export const LedgerMcpClientRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
).annotate({
  description:
    "Optional idempotency key, unique per ledger. Omit it and an identical retry is recognised from the call's arguments. Set it to tell two identical calls apart, and reuse it only when retrying the same call after a lost response. A rejected key stays rejected, so use a new one for a corrected call.",
});

const ItemDraft = Schema.Struct({
  id: LedgerMcpItemKey,
  title: TrimmedNonEmptyString.annotate({ description: "One small, verifiable unit of work." }),
  acceptance: Schema.String.annotate({
    description: "What must be true, and how it is checked, for this item to count as done.",
  }),
  quote: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Makes this one of the user's asks: their words, copied exactly from their message (it is checked). Asks are top-level, close only with proof the user can see, and you can never drop or defer one. Leave it out for your own plan steps, which go under an ask with parentItemId.",
    }),
  ),
  blockedBy: Schema.optionalKey(
    Schema.Array(LedgerMcpItemKey).annotate({
      description:
        "Items that must be closed or dropped before this one can start or close. Same ledger, no cycles.",
    }),
  ),
  parentItemId: Schema.optionalKey(
    LedgerMcpItemKey.annotate({
      description: "Make this a sub-item of that item; the parent cannot close while it is open.",
    }),
  ),
  deferReason: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Record out-of-scope work without doing it: the item starts deferred, with this reason. It is kept for later and not auto-continued.",
    }),
  ),
});

const CheckpointDraft = Schema.Struct({
  id: LedgerMcpCheckpointKey,
  title: TrimmedNonEmptyString,
});

export const LedgerMcpCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  startState: Schema.optional(
    Schema.String.annotate({ description: "Where the task starts, in a sentence or two." }),
  ),
  checkpoints: Schema.optional(Schema.Array(CheckpointDraft)),
  winConditions: Schema.optional(Schema.Array(Schema.String)),
  items: Schema.Array(ItemDraft),
  clientRequestId: Schema.optional(LedgerMcpClientRequestId),
});
export type LedgerMcpCreateInput = typeof LedgerMcpCreateInput.Type;

export const LedgerMcpAddItemsInput = Schema.Struct({
  items: Schema.Array(ItemDraft).check(Schema.isMinLength(1)),
  clientRequestId: Schema.optional(LedgerMcpClientRequestId),
});
export type LedgerMcpAddItemsInput = typeof LedgerMcpAddItemsInput.Type;

export const LedgerMcpUpdateItemInput = Schema.Struct({
  itemId: LedgerMcpItemKey,
  status: Schema.optional(LedgerItemStatus),
  evidence: Schema.optional(
    Schema.String.annotate({
      description: "Concrete proof the item is done: test output, a commit, file:line.",
    }),
  ),
  dropReason: Schema.optional(Schema.String.annotate({ description: "Why the item is dropped." })),
  deferReason: Schema.optional(
    Schema.String.annotate({ description: "Why the item is deferred (status deferred)." }),
  ),
  blockedBy: Schema.optional(
    Schema.Array(LedgerMcpItemKey).annotate({
      description: "Replaces the item's blockers; [] clears them.",
    }),
  ),
  parentItemId: Schema.optional(
    Schema.NullOr(LedgerMcpItemKey).annotate({
      description: "Moves the item under that parent; null moves it to the top level.",
    }),
  ),
  clientRequestId: Schema.optional(LedgerMcpClientRequestId),
});
export type LedgerMcpUpdateItemInput = typeof LedgerMcpUpdateItemInput.Type;

export const LedgerMcpSetCheckpointInput = Schema.Struct({
  checkpointId: LedgerMcpCheckpointKey,
  reached: Schema.Boolean,
  clientRequestId: Schema.optional(LedgerMcpClientRequestId),
});
export type LedgerMcpSetCheckpointInput = typeof LedgerMcpSetCheckpointInput.Type;

export const LedgerMcpRetryInput = Schema.Struct({
  clientRequestId: Schema.optional(LedgerMcpClientRequestId),
});
export type LedgerMcpRetryInput = typeof LedgerMcpRetryInput.Type;

export const LedgerMcpRequestJudgementInput = Schema.Struct({
  itemId: LedgerMcpItemKey,
});
export type LedgerMcpRequestJudgementInput = typeof LedgerMcpRequestJudgementInput.Type;

export const LedgerMcpReadInput = Schema.Struct({
  itemId: Schema.optional(
    LedgerMcpItemKey.annotate({
      description:
        "Read just this item, complete: all of its evidence, verdict notes and tasks. Omit it to read the whole ledger, with long text cut to a head.",
    }),
  ),
});
export type LedgerMcpReadInput = typeof LedgerMcpReadInput.Type;

export const LedgerMcpSnapshot = Schema.Struct({
  ledgerId: Schema.String,
  title: Schema.String,
  /** Only on ledger_read and ledger_create: a write's result does not repeat the goal. */
  startState: Schema.optionalKey(Schema.String),
  winConditions: Schema.optionalKey(Schema.Array(Schema.String)),
  closed: Schema.Boolean,
  requiresJudge: Schema.Boolean.annotate({
    description:
      "True when an item closes only on a passing judge verdict. Closing such an item starts the judge automatically: the item shows judging, then closes on a pass or comes back in_progress with the judge's notes. Dropping or deferring an item already started is judged the same way.",
  }),
  askCheck: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "Present when the last ask to close is first checked against the user's message by a fresh session: closing it shows judging, then it closes on a pass or comes back in_progress with what is still missing. Closing any other item is immediate.",
    }),
  ),
  counts: Schema.Struct({
    open: NonNegativeInt,
    in_progress: NonNegativeInt,
    closed: NonNegativeInt,
    dropped: NonNegativeInt,
    deferred: NonNegativeInt,
  }),
  unfinished: NonNegativeInt.annotate({
    description: "Open plus in_progress items; the thread is auto-continued while this is above 0.",
  }),
  checkpoints: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, reached: Schema.Boolean }),
  ),
  changedOnly: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "Present on every write's result: items lists only the items this call changed, while the counts, unfinished and closed describe the whole ledger. ledger_read shows the rest.",
    }),
  ),
  itemOnly: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "Present on ledger_read with itemId: items holds that one item, complete, and nothing else of the ledger's items.",
    }),
  ),
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      acceptance: Schema.String,
      /** Fork: present on the user's asks; their words, which the item is judged against. */
      quote: Schema.optionalKey(Schema.String),
      status: LedgerItemStatus,
      /** Tree order: each parent is followed by its sub-items, one level deeper. */
      depth: NonNegativeInt,
      parentItemId: Schema.NullOr(Schema.String),
      blockedBy: Schema.Array(Schema.String),
      waitingOn: Schema.Array(Schema.String).annotate({
        description:
          "Blockers not yet closed or dropped; the item cannot start or close until empty.",
      }),
      evidence: Schema.NullOr(Schema.String),
      dropReason: Schema.NullOr(Schema.String),
      deferReason: Schema.NullOr(Schema.String),
      judging: Schema.Boolean.annotate({
        description:
          "The server's judge is checking this item's close request, or its drop or defer request when setAside is present.",
      }),
      setAside: Schema.optionalKey(
        LedgerItemSetAside.annotate({
          description:
            "Present while the judge rules on dropping or deferring started work: the status asked for and the reason.",
        }),
      ),
      verdict: Schema.NullOr(Schema.Literals(["pass", "fail"])),
      verdictNotes: Schema.NullOr(Schema.String),
      judgeError: Schema.NullOr(Schema.String).annotate({
        description: "Why the last automatic judgement ended without a verdict.",
      }),
      judgements: NonNegativeInt.annotate({
        description: "How many times this item has been judged, across reopening and new evidence.",
      }),
      /** Fork: absent when no delegated task worked the item. */
      tasks: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            taskId: Schema.String,
            role: Schema.NullOr(Schema.String),
            model: Schema.String,
            status: Schema.NullOr(OrchestrationV2Subagent.fields.status),
            childThreadId: Schema.String,
          }),
        ).annotate({
          description:
            "Delegated tasks linked to this item with ledgerItemId, in link order. status is live; null once the task is gone. task_status reads a task's report.",
        }),
      ),
      /** Fork: present when older linked tasks were left out of `tasks`. */
      tasksCut: Schema.optionalKey(
        NonNegativeInt.annotate({
          description:
            "How many older tasks are left out of tasks; ledger_read with itemId lists every one.",
        }),
      ),
    }),
  ).annotate({
    description:
      "Long text (title, acceptance, evidence, verdict notes, reasons) is cut to a head and ends with [+N chars cut; ...]: ledger_read with itemId has the rest.",
  }),
  briefs: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "One line per item not shown in full: closed, dropped and deferred items as 'id status: title | head of the evidence or reason', and, only when full items would not fit, unfinished ones too.",
    }),
  ),
  omitted: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Present when items were left out to keep the result under its size limit: how many and which ids. Unfinished items are left out only when even one line each would not fit.",
    }),
  ),
});
export type LedgerMcpSnapshot = typeof LedgerMcpSnapshot.Type;

export const LedgerMcpReadResult = Schema.Struct({
  ledger: Schema.NullOr(LedgerMcpSnapshot),
});
export type LedgerMcpReadResult = typeof LedgerMcpReadResult.Type;

export const LedgerMcpWriteResult = Schema.Struct({
  sequence: NonNegativeInt,
  ledger: Schema.NullOr(LedgerMcpSnapshot),
});
export type LedgerMcpWriteResult = typeof LedgerMcpWriteResult.Type;

export const LedgerMcpJudgementResult = Schema.Struct({
  ...LedgerMcpWriteResult.fields,
  outcome: Schema.Literals(["pass", "fail"]),
  notes: Schema.String,
  judge: Schema.Struct({ instanceId: Schema.String, model: Schema.String }),
});
export type LedgerMcpJudgementResult = typeof LedgerMcpJudgementResult.Type;
