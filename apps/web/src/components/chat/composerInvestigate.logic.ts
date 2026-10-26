/** Fork: the Investigate composer mode's fields and the start request they make. */
import {
  INVESTIGATION_DEFAULT_PARALLEL_APPROACHES,
  INVESTIGATION_MAX_PARALLEL_APPROACHES,
  INVESTIGATION_MIN_PARALLEL_APPROACHES,
  INVESTIGATION_SOLVED_WHEN_MAX_LENGTH,
  type InvestigationBudget,
} from "@t3tools/contracts";

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
  if (goal === "") return { ok: false, problem: "Describe what to investigate in the message." };
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
  const parallelApproaches = Math.min(
    INVESTIGATION_MAX_PARALLEL_APPROACHES,
    Math.max(INVESTIGATION_MIN_PARALLEL_APPROACHES, Math.round(draft.parallelApproaches)),
  );
  return {
    ok: true,
    goal,
    solvedWhen,
    budget: {
      ...(minutes === null ? {} : { minutes }),
      ...(usd === null ? {} : { usd }),
    },
    parallelApproaches,
  };
}
