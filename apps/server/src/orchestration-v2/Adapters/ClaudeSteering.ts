/**
 * Fork: a "next" steer lands at the turn's next tool boundary. With none left, the CLI ends the
 * answer with a result and runs the steer as another segment of the same turn, so a result while
 * a steer still waits (per its command_lifecycle frames) ends a segment, not the turn.
 */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

type ClaudeSteerState = "offered" | "queued" | "started" | "completed" | "cancelled";

const STATE_ORDER: Record<ClaudeSteerState, number> = {
  offered: 0,
  queued: 1,
  started: 2,
  completed: 3,
  cancelled: 3,
};

export interface ClaudeTurnSteers {
  readonly states: Map<string, ClaudeSteerState>;
  // A CLI that sends no lifecycle frames never reports a steer started, so only a CLI seen to
  // send them may hold a turn open; without them a late steer runs as a native wake turn.
  lifecycleSeen: boolean;
  // The result of the segment that ended while a steer waited. It settles the turn if that
  // steer ends without starting, since no other result will come.
  held: SDKResultMessage | null;
}

interface ClaudeSteeredTurn {
  readonly steers: ClaudeTurnSteers;
  readonly steeredSegmentUsage: Array<SDKResultMessage["usage"]>;
}

export function makeClaudeTurnSteers(): ClaudeTurnSteers {
  return { states: new Map(), lifecycleSeen: false, held: null };
}

// Recorded before the offer: the CLI can acknowledge it before the offer returns.
export function recordClaudeSteer(steers: ClaudeTurnSteers, uuid: string): void {
  steers.states.set(uuid, "offered");
}

export function forgetClaudeSteer(steers: ClaudeTurnSteers, uuid: string): void {
  steers.states.delete(uuid);
}

const isWaiting = (state: ClaudeSteerState) => state === "offered" || state === "queued";

function hasWaitingSteer(steers: ClaudeTurnSteers): boolean {
  if (!steers.lifecycleSeen) return false;
  for (const state of steers.states.values()) {
    if (isWaiting(state)) return true;
  }
  return false;
}

/** Holds a result that ends only a segment. False means the result ends the turn. */
export function holdClaudeSegmentResult(
  turn: ClaudeSteeredTurn,
  result: SDKResultMessage,
): boolean {
  if (!hasWaitingSteer(turn.steers)) return false;
  turn.steeredSegmentUsage.push(result.usage);
  turn.steers.held = result;
  return true;
}

function claudeCommandLifecycle(
  message: SDKMessage,
): { readonly uuid: string; readonly state: ClaudeSteerState } | null {
  // The SDK message union does not declare command_lifecycle frames.
  const type: unknown = Reflect.get(message, "type");
  if (type !== "command_lifecycle") return null;
  const uuid: unknown = Reflect.get(message, "command_uuid");
  const state: unknown = Reflect.get(message, "state");
  return typeof uuid === "string" &&
    (state === "queued" || state === "started" || state === "completed" || state === "cancelled")
    ? { uuid, state }
    : null;
}

/**
 * Applies a command_lifecycle frame to the turn's steers. Returns the held segment result when
 * the last waiting steer ends without starting; its usage leaves the segment list because the
 * caller settles the turn with it.
 */
export function observeClaudeSteerLifecycle(
  turn: ClaudeSteeredTurn,
  message: SDKMessage,
): SDKResultMessage | null {
  const lifecycle = claudeCommandLifecycle(message);
  if (lifecycle === null) return null;
  const steers = turn.steers;
  steers.lifecycleSeen = true;
  const current = steers.states.get(lifecycle.uuid);
  if (current === undefined || STATE_ORDER[lifecycle.state] <= STATE_ORDER[current]) return null;
  steers.states.set(lifecycle.uuid, lifecycle.state);
  if (lifecycle.state === "started") {
    // Its segment ends with a result of its own, so the held one no longer settles the turn.
    steers.held = null;
    return null;
  }
  const held = steers.held;
  if (!isWaiting(current) || lifecycle.state === "queued" || held === null) return null;
  if (hasWaitingSteer(steers)) return null;
  steers.held = null;
  turn.steeredSegmentUsage.pop();
  return held;
}

// The SDK runs interrupt({ cancelQueued: true }) (0.3.276) but types interrupt() without options.
interface ClaudeInterruptibleQuery {
  interrupt(options: { readonly cancelQueued: true }): Promise<unknown>;
}

/** Interrupts the turn and cancels uuid-stamped messages still queued, so Stop runs no steer. */
export function interruptClaudeQuery(query: ClaudeInterruptibleQuery): Promise<unknown> {
  return query.interrupt({ cancelQueued: true });
}
