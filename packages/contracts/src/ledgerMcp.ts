import * as Schema from "effect/Schema";

import {
  LedgerCheckpointId,
  LedgerItemId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { LedgerItemStatus } from "./ledger.ts";

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

export const LedgerMcpSnapshot = Schema.Struct({
  ledgerId: Schema.String,
  title: Schema.String,
  startState: Schema.String,
  winConditions: Schema.Array(Schema.String),
  closed: Schema.Boolean,
  requiresJudge: Schema.Boolean.annotate({
    description:
      "True when an item closes only on a passing judge verdict. Closing such an item starts the judge automatically: the item shows judging, then closes on a pass or comes back in_progress with the judge's notes.",
  }),
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
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      acceptance: Schema.String,
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
        description: "The server's judge is checking this item's close request.",
      }),
      verdict: Schema.NullOr(Schema.Literals(["pass", "fail"])),
      verdictNotes: Schema.NullOr(Schema.String),
      judgeError: Schema.NullOr(Schema.String).annotate({
        description: "Why the last automatic judgement ended without a verdict.",
      }),
      judgements: NonNegativeInt.annotate({
        description: "How many times this item has been judged, across reopening and new evidence.",
      }),
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
