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
  SessionCronSummary,
} from "@anthropic-ai/claude-agent-sdk";
import {
  LOADOUT_ROLE_NAMES,
  type Ledger,
  type LedgerItem,
  type LoadoutRole,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2HarnessLedgerState,
  ProviderAdapterV2HarnessLoadout,
  ProviderAdapterV2HarnessThreadPolicy,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { loadoutStructure } from "@t3tools/shared/loadouts";
// Hooks are plain promises and must judge a Windows path whatever the host, so they need both
// path.win32 and path.posix rather than one Effect Path layer.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";

import { decideStopHookNudge, ledgerReplanText } from "../LedgerReplan.ts";

/** Blocks in a row, with the ledger unchanged, before a replan block and then the stop. */
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

// Plan before editing gates only these. A shell can write files too, but the gate is a nudge to
// plan, not a sandbox: a shell edit cannot be told apart from a read, and gating shells would make
// a plain question earn a ledger. A managers loadout is the strict mode.
const FILE_EDIT_TOOLS: ReadonlyArray<string> = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
// Every tool that edits or runs a command. Shells are denied whole: a read-only command cannot be
// told apart reliably. REPL and Monitor run commands too.
const MANAGER_DENIED_WORK_TOOLS: ReadonlyArray<string> = [
  ...FILE_EDIT_TOOLS,
  "Bash",
  "PowerShell",
  "REPL",
  "Monitor",
];
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
  readonly readThreadPolicy?: (
    signal: AbortSignal,
  ) => Promise<ProviderAdapterV2HarnessThreadPolicy | undefined>;
  /** Null when the thread runs solo; undefined when the read failed. */
  readonly readLoadout?: (
    signal: AbortSignal,
  ) => Promise<ProviderAdapterV2HarnessLoadout | null | undefined>;
  /** Without the T3 tools there is no ledger to write, so plan before editing would strand the agent. */
  readonly ledgerTools: boolean;
  /** Where plan mode writes its plan file (see claudePlansDirectory); unknown exempts nothing. */
  readonly plansDirectory?: string;
  /**
   * A delegated child runs in its own thread and works an item of its parent's ledger, so the
   * managers rule and plan before editing bind only the top level.
   */
  readonly delegatedChild: boolean;
  /** The Stop hook's task list omits the CLI's ambient flag, which only its task frames carry. */
  readonly isAmbientTask?: (taskId: string) => boolean;
  /** Each stop's crons, so the between-turn follow-up waits on them too. */
  readonly onSessionCrons?: (crons: ReadonlyArray<SessionCronSummary>) => void;
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

const roleModel = (role: Omit<LoadoutRole, "fallback">) =>
  `${role.model} on ${role.instanceId}${role.effort === undefined ? "" : `, effort ${role.effort}`}`;

/**
 * The thread's loadout as a short block for the model, shared by the Claude prompt hook and
 * Codex's `loadout_state` context. The agent cannot see the loadout any other way short of
 * calling a tool. Undefined when the thread runs solo.
 */
export function formatLoadoutBlock(
  loadout: ProviderAdapterV2HarnessLoadout | null,
): string | undefined {
  if (loadout === null) return undefined;
  const structure = loadoutStructure(loadout);
  const roles = LOADOUT_ROLE_NAMES.flatMap((name) => {
    const role = loadout.roles[name];
    if (role === undefined) return [];
    // The planner is not a delegate_task role: it names the model meant for the thread itself.
    const label = name === "planner" ? "planner (the top-level thread, you)" : name;
    const fallback =
      role.fallback === undefined ? "" : `; falls back to ${roleModel(role.fallback)}`;
    return [`- ${label}: ${roleModel(role)}${fallback}`];
  });
  const use =
    structure === "managers"
      ? "You plan and review only: delegate every edit and shell command with delegate_task and a role (worker or subPlanner)."
      : "Delegate work with delegate_task and a role (worker, explorer, subPlanner) rather than doing it all yourself.";
  const judge =
    loadout.roles.judge === undefined
      ? ""
      : " When ledger_read shows requiresJudge, closing an item with ledger_update_item starts the judge, and the item closes when it passes.";
  return [
    `Loadout: "${clip(loadout.name, TITLE_MAX_CHARS)}", ${loadout.setBy === "user" ? "set by the user" : "proposed by you"}. Structure: ${structure}.`,
    roles.length === 0 ? "Roles: none assigned, so each role runs on your own model." : "Roles:",
    ...roles,
    `${use}${judge}`,
  ].join("\n");
}

export const LOADOUT_WITHDRAWN =
  "This thread now runs solo; the earlier loadout no longer applies.";

/**
 * What the agent should hold about the loadout: its block, or once a block was shown, the notice
 * that withdraws it. Saying nothing would leave the old block standing in the transcript.
 */
export const loadoutContext = (block: string | undefined, shownBefore: boolean) =>
  block ?? (shownBefore ? LOADOUT_WITHDRAWN : undefined);

// A blocked agent may think it is waiting when the CLI sees nothing that will wake it. Marking the
// wait is also what makes the between-turn follow-up stand aside once the stop is allowed.
const STOP_WAIT_HINT =
  "If you are waiting on background work, call t3_background_wait with its task id and end your turn.";

function stopReason(open: ReadonlyArray<LedgerItem>): string {
  const named = open.slice(0, STOP_ITEMS_SHOWN).map(itemLabel).join(", ");
  const hidden = open.length - STOP_ITEMS_SHOWN;
  return `Ledger has ${open.length} open ${open.length === 1 ? "item" : "items"}: ${named}${hidden > 0 ? ` and ${hidden} more` : ""}; continue, close with evidence, or drop with a reason. ${STOP_WAIT_HINT}`;
}

/** What counts as progress: any item changing status, evidence or drop reason. */
const ledgerFingerprint = (ledger: Ledger) =>
  JSON.stringify(
    ledger.items.map((item) => [item.id, item.status, item.evidence, item.dropReason]),
  );

/** An edit is planned only while some item is open or in progress (a judged item stays in progress). */
const plansCurrentWork = (ledger: Ledger | null) =>
  ledger !== null && ledger.closedAt === null && ledger.items.some(isOpen);

function planFirstReason(tool: string, ledger: Ledger | null, subagent: boolean): string {
  // The plan is the main agent's to write; a subagent creating the thread's ledger would bypass it.
  if (subagent) {
    return `This thread has no open or in-progress ledger item for this work, so a subagent's ${tool} is denied until the main agent plans it. Stop and report back that the plan comes first.`;
  }
  // ledger_create is refused after an ended investigation until the user writes again, so pointing
  // at it would only earn a second refusal. The hook cannot see whether the user has written since.
  if ((ledger?.investigation?.endedAt ?? null) !== null) {
    return `This thread's investigation is over, so ${tool} is denied: file edits wait for the user's next message. If the user has written since it ended, plan the work they asked for before editing.`;
  }
  const denied = `Plan before editing is on and`;
  if (ledger !== null && ledger.closedAt === null) {
    return `${denied} the task ledger "${clip(ledger.title, TITLE_MAX_CHARS)}" has no open or in-progress item, so ${tool} is denied: nothing in the plan covers this work. Add an item for it with ledger_add_items, with what done means, then work it and close it with evidence. Reading and searching stay allowed.`;
  }
  const why =
    ledger === null
      ? "this thread has no task ledger"
      : `its task ledger "${clip(ledger.title, TITLE_MAX_CHARS)}" is closed`;
  return `${denied} ${why}, so ${tool} is denied. Write the plan first with ledger_create: each item with what done means (one item is fine for a small change). If the task earns more structure than solo, propose a loadout with t3_loadout_propose. Then work through the items, closing each with evidence. Reading and searching stay allowed.`;
}

/**
 * Where Claude's plan mode writes its plan file: the session's `plansDirectory` setting, which
 * Claude resolves from the project root, else `plans` under the Claude home.
 */
export function claudePlansDirectory(input: {
  readonly claudeHome: string;
  readonly cwd: string | null;
  readonly configured: string | undefined;
}): string {
  const configured = input.configured?.trim() ?? "";
  return configured === ""
    ? NodePath.join(input.claudeHome, "plans")
    : NodePath.resolve(input.cwd ?? input.claudeHome, configured);
}

const filePathOf = (toolInput: unknown) =>
  typeof toolInput === "object" &&
  toolInput !== null &&
  "file_path" in toolInput &&
  typeof toolInput.file_path === "string"
    ? toolInput.file_path
    : undefined;

// The directory comes from the host's path module and the file path from the model, so a Windows
// path can arrive with either separator and any case; path.win32 compares both ways.
function isInsideDirectory(filePath: string, directory: string): boolean {
  const paths = /^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(directory) ? NodePath.win32 : NodePath.posix;
  if (!paths.isAbsolute(filePath)) return false;
  const relative = paths.relative(directory, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative)
  );
}

// Fork: each non-ambient task the SDK lists here wakes the session when it ends, and a cron fires a
// prompt, so blocking the stop only burns blocks to the ceiling. T3's awaited mark is not required:
// the CLI wakes either way. A dev server left running lets the agent stop too; the between-turn
// follow-up applies the awaited rule and covers it.
const waitsOnBackgroundWork = (
  input: Extract<HookInput, { hook_event_name: "Stop" }>,
  isAmbientTask: ((taskId: string) => boolean) | undefined,
) =>
  (input.session_crons ?? []).length > 0 ||
  (input.background_tasks ?? []).some((task) => isAmbientTask?.(task.id) !== true);

export function buildClaudeHarnessHooks(port: HarnessHookPort): ClaudeHooks | undefined {
  const { readPinnedRules, readLedgerState, readThreadPolicy } = port;
  // The roles are reached only through the T3 tools, so without them the loadout goes unmentioned.
  const readLoadout = port.ledgerTools ? port.readLoadout : undefined;
  if (
    readPinnedRules === undefined &&
    readLedgerState === undefined &&
    readThreadPolicy === undefined &&
    readLoadout === undefined
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
  // What this session last sent about the loadout. Task notifications and auto-continue arrive as
  // prompts too, so an unchanged loadout is not repeated; the first prompt and every compaction
  // send it. Sticky like the rules: once a block was sent, Solo withdraws it, again per compaction.
  let loadoutSent: string | undefined;
  const loadoutUpdate = async (signal: AbortSignal, resend: boolean) => {
    if (readLoadout === undefined) return undefined;
    const loadout = await readLoadout(signal);
    if (loadout === undefined) return undefined;
    const context = loadoutContext(formatLoadoutBlock(loadout), loadoutSent !== undefined);
    if (context === undefined || (!resend && context === loadoutSent)) return undefined;
    loadoutSent = context;
    return context;
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
  // rules, the ledger and the loadout, all outside the summary that just replaced the transcript.
  hooks.SessionStart = [
    matcher(async (input, signal) => {
      if (input.hook_event_name !== "SessionStart" || input.source !== "compact") return {};
      const [rules, ledger, loadout] = await Promise.all([
        settle(signal, () => pinnedRulesContext(signal)),
        readLedgerState === undefined
          ? Promise.resolve(undefined)
          : settle(signal, async () =>
              formatLedgerBlock(activeLedger(await readLedgerState(signal))),
            ),
        settle(signal, () => loadoutUpdate(signal, true)),
      ]);
      const parts = [rules, ledger, loadout].filter((part): part is string => part !== undefined);
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
    const judgeReplanned = new Set<string>();
    // Giving up only allows the stop: the run then completes with items open, and
    // LedgerAutoContinue decides the follow-up as for any provider.
    hooks.Stop = [
      matcher(async (input, signal) => {
        if (input.hook_event_name !== "Stop") return {};
        // A stop the hook did not cause is a fresh prompt ending, which earns a fresh allowance.
        if (!input.stop_hook_active) {
          consecutiveBlocks = 0;
          promptBlocks = 0;
          judgeReplanned.clear();
        }
        // First, so every stop's report replaces the last, whatever this hook decides.
        port.onSessionCrons?.(input.session_crons ?? []);
        if (waitsOnBackgroundWork(input, port.isAmbientTask)) return {};
        const state = await readLedgerState(signal);
        // A watched pull request wakes the thread when checks or reviews land.
        if (
          state === undefined ||
          state.userInterrupted ||
          state.delegatedWorkActive ||
          state.pullRequestWatched
        ) {
          return {};
        }
        const ledger = activeLedger(state);
        if (ledger === undefined) return {};
        const open = openItems(ledger);
        if (open.length === 0) return {};
        const fingerprint = ledgerFingerprint(ledger);
        if (fingerprint !== lastFingerprint) {
          consecutiveBlocks = 0;
          lastFingerprint = fingerprint;
        }
        // Fork: the limit's last block asks for a replan, so the stop is allowed one block later.
        const nudge = decideStopHookNudge({
          ledger,
          open,
          unchangedBlocks: consecutiveBlocks,
          limit: HARNESS_STOP_BLOCK_LIMIT,
          judgeReplanned,
        });
        if (nudge.type === "allow") return {};
        // Churn that keeps changing the ledger without closing it must still end.
        if (promptBlocks >= HARNESS_STOP_BLOCK_CEILING) return {};
        consecutiveBlocks++;
        promptBlocks++;
        if (nudge.type === "block") return { decision: "block", reason: stopReason(open) };
        if (nudge.reason === "judge") for (const item of nudge.items) judgeReplanned.add(item.id);
        return {
          decision: "block",
          reason: `${ledgerReplanText({ ledger, reason: nudge.reason, items: nudge.items })}\n\n${STOP_WAIT_HINT}`,
        };
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

  if (readLoadout !== undefined) {
    // Fires once per prompt before the model starts, and reads fresh, so a loadout the user or
    // the agent changed since the last prompt is the one shown. A delegated child reads its own
    // thread, which starts with no loadout, so it hears nothing unless one was set on it.
    hooks.UserPromptSubmit = [
      matcher(async (input, signal) => {
        if (input.hook_event_name !== "UserPromptSubmit") return {};
        const context = await loadoutUpdate(signal, false);
        if (context === undefined) return {};
        return {
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
        };
      }),
    ];
  }

  if (readThreadPolicy !== undefined && !port.delegatedChild) {
    const readPlanLedger = port.ledgerTools ? readLedgerState : undefined;
    const deny = (reason: string): HookJSONOutput => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
    hooks.PreToolUse = [
      matcher(async (input, signal) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const tool = input.tool_name;
        // Plan mode writes its plan file before any plan exists; a ledger forced mid-plan would
        // fight the Stop hook once the plan exits, and a managers thread must write it too.
        const filePath = filePathOf(input.tool_input);
        if (
          input.permission_mode === "plan" &&
          port.plansDirectory !== undefined &&
          filePath !== undefined &&
          FILE_EDIT_TOOLS.includes(tool) &&
          isInsideDirectory(filePath, port.plansDirectory)
        ) {
          return {};
        }
        const managersTool = input.agent_id === undefined && MANAGER_DENIED_TOOLS.includes(tool);
        // A native subagent's edit is gated too: it is the thread editing, and routing an edit
        // through Agent is the obvious way around a denial.
        const planTool = readPlanLedger !== undefined && FILE_EDIT_TOOLS.includes(tool);
        if (!managersTool && !planTool) return {};
        const policy = await readThreadPolicy(signal);
        if (policy === undefined) return {};
        if (managersTool && policy.structure === "managers") {
          const worker = (MANAGER_DENIED_WORKER_TOOLS as ReadonlyArray<string>).includes(tool);
          return deny(
            worker
              ? `This thread runs a managers loadout, so the native ${tool} tool is denied: work goes to the loadout's roles. Use delegate_task with role "worker", "subPlanner" or "explorer".`
              : `This thread runs a managers loadout: the top-level thread does not edit files or run shell commands itself, so ${tool} is denied (shells too, even read-only, since a read-only command cannot be told apart reliably). Delegate the change with delegate_task and role "worker" or "subPlanner", and read files with Read, Grep and Glob.`,
          );
        }
        if (!planTool || readPlanLedger === undefined || !policy.planBeforeEditing) return {};
        // Read on every call, so a ledger or item the agent adds mid-turn lifts the gate on its
        // next edit.
        const state = await readPlanLedger(signal);
        if (state === undefined || plansCurrentWork(state.ledger)) return {};
        return deny(planFirstReason(tool, state.ledger, input.agent_id !== undefined));
      }, MANAGER_DENIED_TOOLS.join("|")),
    ];
  }

  return hooks;
}
