import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AGENT_RULE_PIN_TEXT_MAX_LENGTH, AGENT_RULE_PINS_MAX_COUNT } from "./orchestrationV2.ts";

// Fork: the agent's own pins. Over-cap input is rejected by the planner with a message that names
// the limit; the schema leaves length to it so the agent reads a sentence, not a decode error.
export const AgentPinMcpAddInput = Schema.Struct({
  text: TrimmedNonEmptyString.annotate({
    description: `A short fact worth keeping through context compaction, or a verbatim line from the user. At most ${AGENT_RULE_PIN_TEXT_MAX_LENGTH} characters; at most ${AGENT_RULE_PINS_MAX_COUNT} agent pins per thread. It is re-sent after compaction under "Agent notes (written by the agent, not the user)", never as a user rule.`,
  }),
});
export type AgentPinMcpAddInput = typeof AgentPinMcpAddInput.Type;

export const AgentPinMcpRemoveInput = Schema.Struct({
  pinId: TrimmedNonEmptyString.annotate({
    description: "The id of one of your own pins, as returned by pin_add.",
  }),
});
export type AgentPinMcpRemoveInput = typeof AgentPinMcpRemoveInput.Type;

export const AgentPinMcpResult = Schema.Struct({
  sequence: NonNegativeInt,
  pins: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, text: Schema.String })).annotate({
    description: "Your pins on this thread after the change.",
  }),
});
export type AgentPinMcpResult = typeof AgentPinMcpResult.Type;
