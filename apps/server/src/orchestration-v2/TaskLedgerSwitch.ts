/**
 * Fork: the rule behind the `taskLedger` project setting. A thread runs without the task ledger
 * when its project turned the setting off, its loadout runs on no ledger (none or Solo; see
 * `loadoutRunsOnLedger`) and it has no ledger of its own. Everything that acts on the rule (the
 * instructions a turn sends, the Claude hooks, the ledger tools) asks here, so they cannot disagree.
 */
import type {
  Ledger,
  OrchestrationV2AppThread,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { loadoutRunsOnLedger, resolveLoadout } from "@t3tools/shared/loadouts";
import * as Effect from "effect/Effect";

/** What the rule needs of one thread. */
export interface LedgerLink {
  readonly loadoutId: string | null;
  /** Any ledger, open or closed: a thread that has one keeps working with it. */
  readonly hasLedger: boolean;
  /** The parent of a delegated child; null for every other thread. */
  readonly parentThreadId: ThreadId | null;
}

export const ledgerLinkOf = (records: {
  readonly thread: Pick<OrchestrationV2AppThread, "loadout" | "lineage">;
  readonly ledger?: Ledger | null | undefined;
}): LedgerLink => ({
  loadoutId: records.thread.loadout?.id ?? null,
  hasLedger: records.ledger != null,
  parentThreadId:
    records.thread.lineage.relationshipToParent === "subagent"
      ? records.thread.lineage.parentThreadId
      : null,
});

/** Delegation nests a few levels at most; a chain longer than this is read as a loop. */
const MAX_CHAIN = 8;

/**
 * The thread and then each parent it was delegated from. A delegated child works its parent's
 * ledger item, so the rule judges it by the thread that gave it the work.
 */
export const readLedgerChain = Effect.fn("TaskLedgerSwitch.readLedgerChain")(function* <E>(
  threadId: ThreadId,
  readLink: (threadId: ThreadId) => Effect.Effect<LedgerLink, E>,
) {
  const chain: Array<LedgerLink> = [];
  let next: ThreadId | null = threadId;
  while (next !== null && chain.length < MAX_CHAIN) {
    const link: LedgerLink = yield* readLink(next);
    chain.push(link);
    next = link.parentThreadId;
  }
  return chain as ReadonlyArray<LedgerLink>;
});

type LedgerSwitchSettings = Pick<ServerSettings, "taskLedger" | "loadouts">;

/** A setting that was never written reads as off: only an explicit `true` keeps a plain thread on the ledger. */
export const taskLedgerOff = (
  settings: LedgerSwitchSettings,
  chain: ReadonlyArray<LedgerLink>,
): boolean => {
  if (settings.taskLedger === true) return false;
  const runsOnLedger = chain.some(
    (link) =>
      link.hasLedger || loadoutRunsOnLedger(resolveLoadout(settings.loadouts, link.loadoutId)),
  );
  // A chain that was cut short is not known to be plain, so it stays on the ledger.
  return !runsOnLedger && chain.at(-1)?.parentThreadId === null;
};

/** Reads the chain only when the setting is off, so a project that keeps the ledger pays nothing. */
export const taskLedgerOffFor = <E>(input: {
  readonly settings: LedgerSwitchSettings;
  readonly readChain: Effect.Effect<ReadonlyArray<LedgerLink>, E>;
}): Effect.Effect<boolean, E> =>
  input.settings.taskLedger === true
    ? Effect.succeed(false)
    : Effect.map(input.readChain, (chain) => taskLedgerOff(input.settings, chain));
