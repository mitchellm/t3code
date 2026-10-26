// Fork: the four ways to leave plan mode and start building (H5).
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const BUILD_MODE_ACTIONS = ["build", "compact_and_build", "reset_and_build", "audit"] as const;
export const BuildModeAction = Schema.Literals(BUILD_MODE_ACTIONS);
export type BuildModeAction = typeof BuildModeAction.Type;

export const OrchestrationRunBuildModeInput = Schema.Struct({
  threadId: ThreadId,
  action: BuildModeAction,
  /** The client the person pressed the button in, recorded on the build message like a send. */
  creationSource: Schema.Literals(["web", "mobile"]),
});
export type OrchestrationRunBuildModeInput = typeof OrchestrationRunBuildModeInput.Type;

export const OrchestrationRunBuildModeResult = Schema.Struct({
  action: BuildModeAction,
  /** Audit only: how many findings were appended to the ledger. */
  findings: Schema.optionalKey(Schema.Number),
});
export type OrchestrationRunBuildModeResult = typeof OrchestrationRunBuildModeResult.Type;

export class OrchestrationBuildModeError extends Schema.TaggedError<OrchestrationBuildModeError>()(
  "OrchestrationBuildModeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
