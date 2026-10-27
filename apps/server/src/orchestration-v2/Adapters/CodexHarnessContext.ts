/**
 * Fork: the trusted context Codex gets from thread state, the ledger and loadout blocks. Codex
 * re-sends an additionalContext entry only when its value changes, so each key holds a current
 * value: a loadout the thread drops is replaced by a notice, never just omitted.
 */
import type {
  ProviderAdapterV2HarnessLoadout,
  ProviderAdapterV2HarnessPort,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";

import { buildCodexChunkedContext } from "../../provider/CodexDeveloperInstructions.ts";
import { formatLedgerBlock, formatLoadoutBlock, loadoutContext } from "./HarnessHooks.ts";

type CodexContext = Readonly<Record<string, V2TurnStartParams__AdditionalContextEntry>>;

const LEDGER_KEY = "ledger_state";
const LOADOUT_KEY = "loadout_state";

/** A chunked value read back whole: the chunks split it without loss, in key order. */
function heldValue(context: CodexContext | undefined, key: string): string | undefined {
  const chunks = Object.entries(context ?? {}).filter(([name]) => name.startsWith(key));
  return chunks.length === 0 ? undefined : chunks.map(([, entry]) => entry.value).join("");
}

/**
 * The `loadout_state` value given what Codex already holds. A failed read keeps that value, since
 * dropping the key would not tell the model anything.
 */
export function codexLoadoutState(
  loadout: ProviderAdapterV2HarnessLoadout | null | undefined,
  previous: CodexContext | undefined,
): string | undefined {
  const held = heldValue(previous, LOADOUT_KEY);
  return loadout === undefined
    ? held
    : loadoutContext(formatLoadoutBlock(loadout), held !== undefined);
}

/** Untraced: it runs inside startNativeTurn's span. */
export const readCodexHarnessState = Effect.fnUntraced(function* (input: {
  readonly harness: ProviderAdapterV2HarnessPort | undefined;
  /** The context Codex was last given on this native thread. */
  readonly previous: CodexContext | undefined;
  /** Without the T3 tools the loadout's roles cannot be reached, so it goes unmentioned. */
  readonly t3Tools: boolean;
}) {
  if (input.harness === undefined) return {};
  const ledgerState = formatLedgerBlock((yield* input.harness.readLedgerState)?.ledger);
  const loadoutState = input.t3Tools
    ? codexLoadoutState(yield* input.harness.readLoadout, input.previous)
    : undefined;
  return {
    ...(ledgerState === undefined ? {} : { ledgerState }),
    ...(loadoutState === undefined ? {} : { loadoutState }),
  };
});

const replace = (context: CodexContext, key: string, text: string): CodexContext => ({
  ...Object.fromEntries(Object.entries(context).filter(([name]) => !name.startsWith(key))),
  ...buildCodexChunkedContext(key, text),
});

/**
 * The stored context for a mid-turn compaction to re-inject. The ledger and the loadout move
 * during a turn, so both are re-read rather than restored from the turn-start snapshot; a failed
 * ledger read keeps its snapshot. Untraced: it runs inside restoreAdditionalContext's span.
 */
export const refreshCodexHarnessContext = Effect.fnUntraced(function* (input: {
  readonly harness: ProviderAdapterV2HarnessPort;
  readonly context: CodexContext;
  readonly t3Tools: boolean;
}) {
  const { harness, context } = input;
  const ledger = yield* harness.readLedgerState;
  let fresh = context;
  if (ledger !== undefined) {
    fresh = replace(fresh, LEDGER_KEY, formatLedgerBlock(ledger.ledger) ?? "");
  }
  if (input.t3Tools) {
    fresh = replace(
      fresh,
      LOADOUT_KEY,
      codexLoadoutState(yield* harness.readLoadout, context) ?? "",
    );
  }
  return fresh;
});
