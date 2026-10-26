/**
 * Fork: the Claude SDK hooks that keep ledger discipline inside the agent loop instead of
 * between turns. Every hook returns `{}` rather than throw, since a throwing hook fails the
 * agent's own tool call or stop, and every read honours the hook's abort signal.
 */
import type {
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Ledger, LedgerItem, LoadoutStructure } from "@t3tools/contracts";
import type { ProviderAdapterV2HarnessLedgerState } from "@t3tools/provider-core/server/ProviderAdapter";

/** Blocks in a row, with the ledger unchanged, before the agent may stop anyway. */
export const HARNESS_STOP_BLOCK_LIMIT = 3;
/** Blocks in one prompt, progress or not, before the agent may stop anyway. */
export const HARNESS_STOP_BLOCK_CEILING = 20;
/** Tool calls between ledger reminders. */
export const HARNESS_REMINDER_EVERY = 15;

const HOOK_TIMEOUT_SECONDS = 5;
const LEDGER_BLOCK_MAX_CHARS = 3_000;
const TITLE_MAX_CHARS = 80;
const ACCEPTANCE_MAX_CHARS = 600;
const WIN_CONDITIONS_SHOWN = 6;
const WIN_CONDITION_MAX_CHARS = 200;
const OPEN_ITEMS_SHOWN = 20;
const STOP_ITEMS_SHOWN = 5;

// Every tool that edits or runs a command. Shells are denied whole: a read-only command cannot be
// told apart reliably. REPL and Monitor run commands too.
const MANAGER_DENIED_WORK_TOOLS = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "REPL",
  "Monitor",
] as const;
// Native workers would let the top level route edits around the loadout's roles.
const MANAGER_DENIED_WORKER_TOOLS = ["Agent", "Task", "Workflow"] as const;
const MANAGER_DENIED_TOOLS: ReadonlyArray<string> = [
  ...MANAGER_DENIED_WORK_TOOLS,
  ...MANAGER_DENIED_WORKER_TOOLS,
];

export interface HarnessHookPort {
  /** Undefined means the read failed, which is not the same as cleared (""). */
  readonly readPinnedRules?: (signal: AbortSignal) => Promise<string | undefined>;
  /** The session's fixed system prompt carried rules, so a clear has to withdraw them. */
  readonly openedWithPinnedRules: boolean;
  readonly readLedgerState?: (
    signal: AbortSignal,
  ) => Promise<ProviderAdapterV2HarnessLedgerState | undefined>;
  readonly readStructure?: (signal: AbortSignal) => Promise<LoadoutStructure | undefined>;
  /** A delegated child runs in its own thread; the managers rule binds only the top level. */
  readonly delegatedChild: boolean;
  readonly onHookError: (cause: unknown) => void;
}

type ClaudeHooks = NonNullable<ClaudeQueryOptions["hooks"]>;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const isOpen = (item: LedgerItem) => item.status === "open" || item.status === "in_progress";

/** In-progress first: it is what the agent should pick back up. */
const openItems = (ledger: Ledger): ReadonlyArray<LedgerItem> => [
  ...ledger.items.filter((item) => item.status === "in_progress"),
  ...ledger.items.filter((item) => item.status === "open"),
];

const activeLedger = (state: ProviderAdapterV2HarnessLedgerState | undefined) =>
  state?.ledger != null && state.ledger.closedAt === null ? state.ledger : undefined;

const itemLabel = (item: LedgerItem) => `${item.id} ${clip(item.title, TITLE_MAX_CHARS)}`;

/**
 * The ledger as a compact block for the model, shared by the Claude compact hook and Codex's
 * `ledger_state` context. Undefined when there is no live ledger.
 */
export function formatLedgerBlock(ledger: Ledger | null | undefined): string | undefined {
  if (ledger == null || ledger.closedAt !== null) return undefined;
  const lines = [
    `Task ledger "${clip(ledger.title, TITLE_MAX_CHARS)}". ledger_read has the full record.`,
  ];
  if (ledger.winConditions.length > 0) {
    lines.push("Win conditions:");
    for (const condition of ledger.winConditions.slice(0, WIN_CONDITIONS_SHOWN)) {
      lines.push(`- ${clip(condition, WIN_CONDITION_MAX_CHARS)}`);
    }
    const hidden = ledger.winConditions.length - WIN_CONDITIONS_SHOWN;
    if (hidden > 0) lines.push(`- and ${hidden} more`);
  }
  const inProgress = ledger.items.filter((item) => item.status === "in_progress");
  for (const item of inProgress.slice(0, 2)) {
    lines.push(`In progress: ${itemLabel(item)}`);
    lines.push(`Acceptance: ${clip(item.acceptance, ACCEPTANCE_MAX_CHARS)}`);
  }
  const open = ledger.items.filter((item) => item.status === "open");
  const rest = [...inProgress.slice(2), ...open];
  if (rest.length > 0) {
    lines.push(`Open (${rest.length}):`);
    for (const item of rest.slice(0, OPEN_ITEMS_SHOWN)) lines.push(`- ${itemLabel(item)}`);
    if (rest.length > OPEN_ITEMS_SHOWN) lines.push(`- and ${rest.length - OPEN_ITEMS_SHOWN} more`);
  }
  if (inProgress.length === 0 && open.length === 0) lines.push("No open items.");
  return clip(lines.join("\n"), LEDGER_BLOCK_MAX_CHARS);
}

function stopReason(open: ReadonlyArray<LedgerItem>): string {
  const named = open.slice(0, STOP_ITEMS_SHOWN).map(itemLabel).join(", ");
  const hidden = open.length - STOP_ITEMS_SHOWN;
  return `Ledger has ${open.length} open ${open.length === 1 ? "item" : "items"}: ${named}${hidden > 0 ? ` and ${hidden} more` : ""}; continue, close with evidence, or drop with a reason.`;
}

/** What counts as progress: any item changing status, evidence or drop reason. */
const ledgerFingerprint = (ledger: Ledger) =>
  JSON.stringify(
    ledger.items.map((item) => [item.id, item.status, item.evidence, item.dropReason]),
  );

// The SDK reports in-flight background work at a stop; a subagent there will wake the agent.
const waitsOnBackgroundSubagent = (input: Extract<HookInput, { hook_event_name: "Stop" }>) =>
  (input.background_tasks ?? []).some((task) => task.type === "subagent");

export function buildClaudeHarnessHooks(port: HarnessHookPort): ClaudeHooks | undefined {
  const { readPinnedRules, readLedgerState, readStructure } = port;
  if (
    readPinnedRules === undefined &&
    readLedgerState === undefined &&
    readStructure === undefined
  ) {
    return undefined;
  }
  const guard =
    (run: (input: HookInput, signal: AbortSignal) => Promise<HookJSONOutput>) =>
    async (
      input: HookInput,
      _toolUseId: string | undefined,
      options: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      if (options.signal.aborted) return {};
      try {
        return await run(input, options.signal);
      } catch (cause) {
        // An aborted read rejects by design; only a real failure is worth a log line.
        if (!options.signal.aborted) port.onHookError(cause);
        return {};
      }
    };
  const matcher = (
    run: (input: HookInput, signal: AbortSignal) => Promise<HookJSONOutput>,
    pattern?: string,
  ): HookCallbackMatcher => ({
    ...(pattern === undefined ? {} : { matcher: pattern }),
    timeout: HOOK_TIMEOUT_SECONDS,
    hooks: [guard(run)],
  });
  const hooks: ClaudeHooks = {};

  // Sticky on purpose: a later compaction may summarize the copy away, but the
  // summary can still carry its gist, so every later clear withdraws again.
  let rulesDeliveredByHook = false;
  const pinnedRulesContext = async (signal: AbortSignal): Promise<string | undefined> => {
    if (readPinnedRules === undefined) return undefined;
    const rules = await readPinnedRules(signal);
    if (rules === undefined) return undefined;
    if (rules === "") {
      return port.openedWithPinnedRules || rulesDeliveredByHook
        ? "There are no pinned rules now. Any earlier pinned rules, in the system prompt or re-sent after a compaction, are withdrawn."
        : undefined;
    }
    rulesDeliveredByHook = true;
    return `These are the current pinned rules. They supersede any earlier version in the system prompt.\n\n${rules}`;
  };
  // A failed rules read must not cost the ledger block, nor the reverse.
  const settle = async <A>(
    signal: AbortSignal,
    read: () => Promise<A | undefined>,
  ): Promise<A | undefined> => {
    try {
      return await read();
    } catch (cause) {
      if (!signal.aborted) port.onHookError(cause);
      return undefined;
    }
  };

  // The system prompt is fixed when the CLI opens, so after a compaction this re-sends the current
  // rules and the ledger, both outside the summary that just replaced the transcript.
  hooks.SessionStart = [
    matcher(async (input, signal) => {
      if (input.hook_event_name !== "SessionStart" || input.source !== "compact") return {};
      const [rules, ledger] = await Promise.all([
        settle(signal, () => pinnedRulesContext(signal)),
        readLedgerState === undefined
          ? Promise.resolve(undefined)
          : settle(signal, async () =>
              formatLedgerBlock(activeLedger(await readLedgerState(signal))),
            ),
      ]);
      const parts = [rules, ledger].filter((part): part is string => part !== undefined);
      if (parts.length === 0) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: parts.join("\n\n"),
        },
      };
    }, "compact"),
  ];

  if (readLedgerState !== undefined) {
    let consecutiveBlocks = 0;
    let promptBlocks = 0;
    let lastFingerprint: string | undefined;
    // Giving up only allows the stop: the run then completes with items open, and
    // LedgerAutoContinue posts the stop notice and unread mark for it, as for any provider.
    hooks.Stop = [
      matcher(async (input, signal) => {
        if (input.hook_event_name !== "Stop") return {};
        // A stop the hook did not cause is a fresh prompt ending, which earns a fresh allowance.
        if (!input.stop_hook_active) {
          consecutiveBlocks = 0;
          promptBlocks = 0;
        }
        if (waitsOnBackgroundSubagent(input)) return {};
        const state = await readLedgerState(signal);
        if (state === undefined || state.userInterrupted || state.delegatedWorkActive) return {};
        const ledger = activeLedger(state);
        if (ledger === undefined) return {};
        const open = openItems(ledger);
        if (open.length === 0) return {};
        const fingerprint = ledgerFingerprint(ledger);
        if (fingerprint !== lastFingerprint) {
          consecutiveBlocks = 0;
          lastFingerprint = fingerprint;
        }
        if (consecutiveBlocks >= HARNESS_STOP_BLOCK_LIMIT) return {};
        // Churn that keeps changing the ledger without closing it must still end.
        if (promptBlocks >= HARNESS_STOP_BLOCK_CEILING) return {};
        consecutiveBlocks++;
        promptBlocks++;
        return { decision: "block", reason: stopReason(open) };
      }),
    ];

    // Best effort: the SDK has no PreCompact output field, and whether Claude Code folds this
    // message into the compaction instructions is unverified. SessionStart(compact) above is the
    // guaranteed path, since it re-sends the ledger after the summary either way.
    hooks.PreCompact = [
      matcher(async (input, signal) => {
        if (input.hook_event_name !== "PreCompact") return {};
        const ledger = activeLedger(await readLedgerState(signal));
        if (ledger === undefined) return {};
        const open = openItems(ledger);
        if (open.length === 0) return {};
        const inProgress = open.filter((item) => item.status === "in_progress");
        const others = open.filter((item) => item.status === "open");
        return {
          systemMessage: [
            "Keep the task ledger recoverable in the summary.",
            ...inProgress.map(
              (item) =>
                `Keep the in-progress item ${itemLabel(item)} with its acceptance and what was last done on it.`,
            ),
            others.length === 0
              ? ""
              : `Keep the open item ids: ${others.map((item) => item.id).join(", ")}.`,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }),
    ];

    let toolCalls = 0;
    hooks.PostToolUse = [
      matcher(async (input, signal) => {
        // A native subagent's calls are its own work, not the thread's drift.
        if (input.hook_event_name !== "PostToolUse" || input.agent_id !== undefined) return {};
        toolCalls++;
        if (toolCalls % HARNESS_REMINDER_EVERY !== 0) return {};
        const ledger = activeLedger(await readLedgerState(signal));
        if (ledger === undefined) return {};
        const open = ledger.items.filter(isOpen);
        if (open.length === 0) return {};
        const current = ledger.items.find((item) => item.status === "in_progress");
        const focus =
          current === undefined
            ? `nothing in progress; next ${itemLabel(open[0]!)}`
            : `in progress ${itemLabel(current)}`;
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `Ledger reminder: ${focus}; ${open.length} open.`,
          },
        };
      }),
    ];
  }

  if (readStructure !== undefined && !port.delegatedChild) {
    hooks.PreToolUse = [
      matcher(async (input, signal) => {
        if (input.hook_event_name !== "PreToolUse" || input.agent_id !== undefined) return {};
        if (!MANAGER_DENIED_TOOLS.includes(input.tool_name)) return {};
        if ((await readStructure(signal)) !== "managers") return {};
        const worker = (MANAGER_DENIED_WORKER_TOOLS as ReadonlyArray<string>).includes(
          input.tool_name,
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: worker
              ? `This thread runs a managers loadout, so the native ${input.tool_name} tool is denied: work goes to the loadout's roles. Use delegate_task with role "worker", "subPlanner" or "explorer".`
              : `This thread runs a managers loadout: the top-level thread does not edit files or run shell commands itself, so ${input.tool_name} is denied (shells too, even read-only, since a read-only command cannot be told apart reliably). Delegate the change with delegate_task and role "worker" or "subPlanner", and read files with Read, Grep and Glob.`,
          },
        };
      }, MANAGER_DENIED_TOOLS.join("|")),
    ];
  }

  return hooks;
}
