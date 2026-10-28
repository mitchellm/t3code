/** Fork: the Investigate composer mode's fields and the start request they make. */
import {
  INVESTIGATION_DEFAULT_PARALLEL_APPROACHES,
  INVESTIGATION_MAX_PARALLEL_APPROACHES,
  INVESTIGATION_MIN_PARALLEL_APPROACHES,
  INVESTIGATION_SOLVED_WHEN_MAX_LENGTH,
  type InvestigationBudget,
  type ThreadLoadout,
} from "@t3tools/contracts";

import type { ComposerMode } from "./composerMode.logic";

/** Kept as typed text so a half-typed number is not rewritten under the cursor. */
export interface InvestigateDraft {
  readonly solvedWhen: string;
  readonly minutes: string;
  readonly usd: string;
  readonly parallelApproaches: number;
}

export const EMPTY_INVESTIGATE_DRAFT: InvestigateDraft = {
  solvedWhen: "",
  minutes: "30",
  usd: "",
  parallelApproaches: INVESTIGATION_DEFAULT_PARALLEL_APPROACHES,
};

export type InvestigateStart =
  | {
      readonly ok: true;
      readonly goal: string;
      readonly solvedWhen: string;
      readonly budget: InvestigationBudget;
      readonly parallelApproaches: number;
    }
  | { readonly ok: false; readonly problem: string };

const parsePositive = (text: string): number | null | "invalid" => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : "invalid";
};

/** Checks the fields the server would refuse, so the composer says why before sending. */
export function buildInvestigateStart(draft: InvestigateDraft, prompt: string): InvestigateStart {
  const goal = prompt.trim();
  if (goal === "") {
    return { ok: false, problem: "Write the goal above. Solved when is how the judge checks it." };
  }
  const solvedWhen = draft.solvedWhen.trim();
  if (solvedWhen === "") {
    return { ok: false, problem: "Say when the investigation is solved." };
  }
  if (solvedWhen.length > INVESTIGATION_SOLVED_WHEN_MAX_LENGTH) {
    return {
      ok: false,
      problem: `Keep "Solved when" under ${INVESTIGATION_SOLVED_WHEN_MAX_LENGTH} characters.`,
    };
  }
  const minutes = parsePositive(draft.minutes);
  const usd = parsePositive(draft.usd);
  if (minutes === "invalid" || (typeof minutes === "number" && !Number.isInteger(minutes))) {
    return { ok: false, problem: "The time budget is a whole number of minutes." };
  }
  if (usd === "invalid") return { ok: false, problem: "The dollar budget is a positive amount." };
  if (minutes === null && usd === null) {
    return { ok: false, problem: "Set a budget in minutes, dollars, or both." };
  }
  return {
    ok: true,
    goal,
    solvedWhen,
    budget: {
      ...(minutes === null ? {} : { minutes }),
      ...(usd === null ? {} : { usd }),
    },
    parallelApproaches: clampParallelApproaches(draft.parallelApproaches),
  };
}

export function clampParallelApproaches(value: number): number {
  if (!Number.isFinite(value)) return INVESTIGATION_DEFAULT_PARALLEL_APPROACHES;
  return Math.min(
    INVESTIGATION_MAX_PARALLEL_APPROACHES,
    Math.max(INVESTIGATION_MIN_PARALLEL_APPROACHES, Math.round(value)),
  );
}

/**
 * Where the goal is sent: an existing thread, or a draft whose thread the send creates. Either
 * way the loadout it runs under is named, since the server refuses one without a judge.
 */
export type InvestigateSendTarget =
  | { readonly kind: "thread"; readonly loadoutName: string; readonly hasJudge: boolean }
  | {
      readonly kind: "draft";
      readonly loadout: ThreadLoadout | null;
      readonly loadoutName: string;
      readonly hasJudge: boolean;
      /** The draft is set to start in a new worktree, which only a first message prepares. */
      readonly newWorktree: boolean;
    };

export type InvestigateSendStep =
  | { readonly type: "persist-thread-settings" }
  | { readonly type: "create-thread" }
  | { readonly type: "set-loadout"; readonly loadout: ThreadLoadout }
  | {
      readonly type: "start-investigation";
      readonly start: Omit<Extract<InvestigateStart, { ok: true }>, "ok">;
    };

export type InvestigateSendPlan =
  | { readonly kind: "turn" }
  | { readonly kind: "refused"; readonly problem: string }
  | { readonly kind: "investigation"; readonly steps: ReadonlyArray<InvestigateSendStep> };

const needsJudge = (loadoutName: string): InvestigateSendPlan => ({
  kind: "refused",
  problem: `Investigate needs a loadout with a judge role to refute each approach, and ${loadoutName} has none. Pick one in the loadout picker.`,
});

/**
 * What Send does in each mode. Build and Plan are the composer's ordinary turn. Investigate on a
 * thread saves the thread's settings, since the investigation's kickoff runs under them, then
 * starts it. On a draft it creates the thread and sets its loadout first. Either way it refuses up
 * front what could not start, so a refusal saves nothing and leaves no empty thread behind.
 */
export function planInvestigateSend(input: {
  readonly mode: ComposerMode;
  readonly fields: InvestigateDraft | null;
  readonly prompt: string;
  readonly hasAttachments: boolean;
  readonly target: InvestigateSendTarget;
}): InvestigateSendPlan {
  if (input.mode !== "investigate" || input.fields === null) return { kind: "turn" };
  if (input.hasAttachments) {
    return {
      kind: "refused",
      problem:
        "An investigation's goal is text only. Remove the attachments, or switch to Build to send them as a normal message.",
    };
  }
  const built = buildInvestigateStart(input.fields, input.prompt);
  if (!built.ok) return { kind: "refused", problem: built.problem };
  const { ok: _ok, ...start } = built;
  const begin = { type: "start-investigation", start } as const;
  const { target } = input;
  if (target.kind === "thread") {
    if (!target.hasJudge) return needsJudge(target.loadoutName);
    return { kind: "investigation", steps: [{ type: "persist-thread-settings" }, begin] };
  }
  if (!target.hasJudge || target.loadout === null) return needsJudge(target.loadoutName);
  if (target.newWorktree) {
    return {
      kind: "refused",
      problem:
        'Investigate on a new chat starts in the current checkout. Switch "New worktree" to "Current checkout" to start it here.',
    };
  }
  return {
    kind: "investigation",
    steps: [{ type: "create-thread" }, { type: "set-loadout", loadout: target.loadout }, begin],
  };
}

/**
 * The line under the fields. It runs the same rules as Send, so what Send would refuse shows while
 * the fields are filled in rather than as a toast after.
 */
export function investigateHint(input: {
  readonly fields: InvestigateDraft;
  readonly prompt: string;
  readonly target: InvestigateSendTarget;
}): { readonly tone: "info" | "warning"; readonly text: string } {
  const plan = planInvestigateSend({ ...input, mode: "investigate", hasAttachments: false });
  return plan.kind === "refused"
    ? { tone: "warning", text: plan.problem }
    : { tone: "info", text: "Send starts it. The budget ends it if nothing passes first." };
}

const isFailure = <R extends { readonly _tag: string }>(
  result: R,
): result is Extract<R, { readonly _tag: "Failure" }> => result._tag === "Failure";

/**
 * Runs a planned start in order, stopping at the first failure. `inFlight` is the composer's own
 * send guard for this thread or draft, so while a draft's thread is being created no other send
 * from it, in any mode, can create a second one.
 */
export async function runInvestigateSteps<R extends { readonly _tag: string }>(input: {
  readonly steps: ReadonlyArray<InvestigateSendStep>;
  readonly inFlight: { current: boolean };
  readonly run: (step: InvestigateSendStep) => Promise<R>;
}): Promise<
  | { readonly kind: "done" | "busy" }
  | { readonly kind: "failed"; readonly result: Extract<R, { readonly _tag: "Failure" }> }
> {
  if (input.inFlight.current) return { kind: "busy" };
  input.inFlight.current = true;
  // A step that throws instead of settling must not leave the composer unable to send.
  try {
    for (const step of input.steps) {
      const result = await input.run(step);
      if (isFailure(result)) return { kind: "failed", result };
    }
    return { kind: "done" };
  } finally {
    input.inFlight.current = false;
  }
}
