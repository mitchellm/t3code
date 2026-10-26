import type { LedgerId, LedgerItemId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class LedgerJudgeRunnerError extends Schema.TaggedError<LedgerJudgeRunnerError>()(
  "LedgerJudgeRunnerError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface LedgerJudgeStartInput {
  readonly threadId: ThreadId;
  readonly ledgerId: LedgerId;
  readonly itemId: LedgerItemId;
  /** The judging item's `updatedAt` (ISO) when the close request was made. */
  readonly requestedAt: string;
}

export interface LedgerJudgeRunnerShape {
  /**
   * Starts (or rejoins) the judge for one close request and records its task, then returns; the
   * verdict is recorded when the judge task ends. Settles a stale or unstartable request itself.
   * Fails only for a retryable fault.
   */
  readonly start: (input: LedgerJudgeStartInput) => Effect.Effect<void, LedgerJudgeRunnerError>;
  /** Supplies the implementation; see `layerLateBound`. */
  readonly bind: (implementation: Pick<LedgerJudgeRunnerShape, "start">) => Effect.Effect<void>;
}

/**
 * Fork: the effect worker's way to start a ledger judge. Judging is a delegation, which needs the
 * MCP orchestrator service built above the runtime layer that owns the worker, so the worker gets
 * this port and the server binds it at startup.
 */
export class LedgerJudgeRunner extends Context.Reference<LedgerJudgeRunnerShape>(
  "t3/orchestration-v2/LedgerJudgeRunner",
  {
    defaultValue: () => ({
      start: () =>
        Effect.fail(
          new LedgerJudgeRunnerError({
            detail: "No ledger judge runner is set up in this process.",
          }),
        ),
      bind: () => Effect.void,
    }),
  },
) {}

// Long enough for server startup to bind it; a process that never binds (a CLI) fails the effect,
// whose retries end by handing the item back.
const BIND_WAIT = Duration.seconds(30);

export const layerLateBound = Layer.effect(
  LedgerJudgeRunner,
  Effect.gen(function* () {
    const bound = yield* Deferred.make<Pick<LedgerJudgeRunnerShape, "start">>();
    return {
      start: (input) =>
        Deferred.await(bound).pipe(
          Effect.timeoutOption(BIND_WAIT),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new LedgerJudgeRunnerError({ detail: "The ledger judge runner is not ready." }),
                ),
              onSome: (implementation) => implementation.start(input),
            }),
          ),
        ),
      bind: (implementation) => Deferred.succeed(bound, implementation).pipe(Effect.asVoid),
    } satisfies LedgerJudgeRunnerShape;
  }),
);
