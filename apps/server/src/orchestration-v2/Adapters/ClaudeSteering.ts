/**
 * Fork: a "next" steer lands at the turn's next tool boundary. With none left, the CLI ends the
 * answer with a result and runs the steer as another segment of the same turn, so a result while
 * a steer still waits (per its command_lifecycle frames) ends a segment, not the turn.
 */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

type ClaudeSteerState = "offered" | "queued" | "started" | "completed" | "cancelled" | "expired";

const STATE_ORDER: Record<ClaudeSteerState, number> = {
  offered: 0,
  queued: 1,
  started: 2,
  completed: 3,
  cancelled: 3,
  expired: 3,
};

// The CLI takes a waiting steer in as soon as the held answer's result is out (spike S0: in the
// same tick). Like the wake-turn deadline, two minutes is far past that; it only bounds a steer
// the CLI never takes in, so an unwatched run (a scheduled task, a delegated wake) still settles.
export const CLAUDE_STEER_START_DEADLINE = "2 minutes";

interface ClaudeSteer {
  state: ClaudeSteerState;
  readonly messageId: string;
}

export interface ClaudeTurnSteers {
  readonly byUuid: Map<string, ClaudeSteer>;
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
  return { byUuid: new Map(), lifecycleSeen: false, held: null };
}

// Recorded before the offer: the CLI can acknowledge it before the offer returns.
export function recordClaudeSteer(steers: ClaudeTurnSteers, uuid: string, messageId: string) {
  steers.byUuid.set(uuid, { state: "offered", messageId });
}

export function forgetClaudeSteer(steers: ClaudeTurnSteers, uuid: string): void {
  steers.byUuid.delete(uuid);
}

const isWaiting = (state: ClaudeSteerState) => state === "offered" || state === "queued";

function hasWaitingSteer(steers: ClaudeTurnSteers): boolean {
  if (!steers.lifecycleSeen) return false;
  for (const steer of steers.byUuid.values()) {
    if (isWaiting(steer.state)) return true;
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

// The caller settles the turn with the held result, so it no longer counts as an earlier segment.
function releaseHeld(turn: ClaudeSteeredTurn, held: SDKResultMessage): SDKResultMessage {
  turn.steers.held = null;
  turn.steeredSegmentUsage.pop();
  return held;
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
 * the last waiting steer ends without starting, for the caller to settle the turn with.
 */
export function observeClaudeSteerLifecycle(
  turn: ClaudeSteeredTurn,
  message: SDKMessage,
): SDKResultMessage | null {
  const lifecycle = claudeCommandLifecycle(message);
  if (lifecycle === null) return null;
  const steers = turn.steers;
  steers.lifecycleSeen = true;
  const steer = steers.byUuid.get(lifecycle.uuid);
  if (steer === undefined || STATE_ORDER[lifecycle.state] <= STATE_ORDER[steer.state]) return null;
  const wasWaiting = isWaiting(steer.state);
  steer.state = lifecycle.state;
  if (lifecycle.state === "started") {
    // Its segment ends with a result of its own, so the held one no longer settles the turn.
    steers.held = null;
    return null;
  }
  const held = steers.held;
  if (!wasWaiting || lifecycle.state === "queued" || held === null) return null;
  return hasWaitingSteer(steers) ? null : releaseHeld(turn, held);
}

/**
 * Gives up on the steers still waiting once the start deadline for `held` passes. Returns the
 * result to settle the turn with and the given-up steers' message ids, or null when a steer
 * started or another result was held since.
 */
export function expireClaudeSteers(
  turn: ClaudeSteeredTurn,
  held: SDKResultMessage,
): { readonly result: SDKResultMessage; readonly messageIds: ReadonlyArray<string> } | null {
  if (turn.steers.held !== held) return null;
  const messageIds: Array<string> = [];
  for (const steer of turn.steers.byUuid.values()) {
    if (!isWaiting(steer.state)) continue;
    steer.state = "expired";
    messageIds.push(steer.messageId);
  }
  return { result: releaseHeld(turn, held), messageIds };
}

// The SDK runs interrupt({ cancelQueued: true }) (0.3.276) but types interrupt() without options.
interface ClaudeInterruptibleQuery {
  interrupt(options?: { readonly cancelQueued: true }): Promise<unknown>;
}

/** Interrupts the turn and cancels uuid-stamped messages still queued, so Stop runs no steer. */
export async function interruptClaudeQuery(query: ClaudeInterruptibleQuery): Promise<unknown> {
  try {
    return await query.interrupt({ cancelQueued: true });
  } catch {
    // A CLI that rejects cancel_queued still takes a plain interrupt; Stop closes the query next.
    return query.interrupt();
  }
}
