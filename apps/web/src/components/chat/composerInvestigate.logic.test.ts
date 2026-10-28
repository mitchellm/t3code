import { type Loadout, type LoadoutRole, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildInvestigateStart,
  clampParallelApproaches,
  EMPTY_INVESTIGATE_DRAFT,
  investigateHint,
  investigateJudge,
  type InvestigateSendTarget,
  planInvestigateSend,
  runInvestigateSteps,
} from "./composerInvestigate.logic";

const fields = { ...EMPTY_INVESTIGATE_DRAFT, solvedWhen: "A failing test passes." };
const goal = "Why does sync drop rows?";
const start = {
  goal,
  solvedWhen: "A failing test passes.",
  budget: { minutes: 30 },
  parallelApproaches: EMPTY_INVESTIGATE_DRAFT.parallelApproaches,
};
const judged = { id: "judged", reason: null, setBy: "user" } as const;
const noJudge =
  "Investigate needs a loadout with a judge role to refute each approach, and Solo has none. Pick one in the loadout picker.";
const soloJudge = { loadoutName: "Solo", judge: { kind: "none" } } as const;
const judgeOff = { judge: { kind: "off", provider: "Codex" } } as const;
const thread = (
  patch: Partial<Extract<InvestigateSendTarget, { kind: "thread" }>> = {},
): InvestigateSendTarget => ({
  kind: "thread",
  loadoutName: "Judged",
  judge: { kind: "ready" },
  ...patch,
});
const draft = (
  patch: Partial<Extract<InvestigateSendTarget, { kind: "draft" }>> = {},
): InvestigateSendTarget => ({
  kind: "draft",
  loadout: judged,
  loadoutName: "Judged",
  judge: { kind: "ready" },
  newWorktree: false,
  ...patch,
});
const send = (
  mode: "build" | "plan" | "investigate",
  target: InvestigateSendTarget,
  patch: { readonly prompt?: string; readonly hasAttachments?: boolean } = {},
) =>
  planInvestigateSend({
    mode,
    fields: mode === "investigate" ? fields : null,
    prompt: patch.prompt ?? goal,
    hasAttachments: patch.hasAttachments ?? false,
    target,
  });

describe("planInvestigateSend", () => {
  it("leaves Build and Plan to the composer's turn, on a draft and on a thread", () => {
    for (const mode of ["build", "plan"] as const) {
      expect(send(mode, draft())).toEqual({ kind: "turn" });
      expect(send(mode, thread())).toEqual({ kind: "turn" });
    }
  });

  it("starts an investigation on a thread with a judge after saving the thread's settings", () => {
    expect(send("investigate", thread())).toEqual({
      kind: "investigation",
      steps: [{ type: "persist-thread-settings" }, { type: "start-investigation", start }],
    });
  });

  it("refuses a thread whose loadout has no judge, as the server would", () => {
    expect(send("investigate", thread(soloJudge))).toEqual({ kind: "refused", problem: noJudge });
  });

  it("refuses a thread or a draft whose judge's provider is off for the project", () => {
    for (const target of [thread(judgeOff), draft(judgeOff)]) {
      expect(send("investigate", target)).toEqual({
        kind: "refused",
        problem:
          "Judged's judge runs on Codex, which is off for this project. Enable it in Settings → Providers or pick another loadout.",
      });
    }
  });

  it("creates a draft's thread under its loadout before starting the investigation", () => {
    expect(send("investigate", draft())).toEqual({
      kind: "investigation",
      steps: [
        { type: "create-thread" },
        { type: "set-loadout", loadout: judged },
        { type: "start-investigation", start },
      ],
    });
  });

  it("refuses a draft before creating anything when nothing could start", () => {
    expect(send("investigate", draft({ loadout: null, ...soloJudge }))).toEqual({
      kind: "refused",
      problem: noJudge,
    });
    expect(send("investigate", draft({ newWorktree: true }))).toMatchObject({ kind: "refused" });
    expect(send("investigate", draft(), { hasAttachments: true })).toMatchObject({
      kind: "refused",
    });
    expect(send("investigate", draft(), { prompt: " " })).toMatchObject({ kind: "refused" });
  });
});

describe("investigateHint", () => {
  const hint = (prompt: string, target: InvestigateSendTarget) =>
    investigateHint({ fields, prompt, target });

  it("names what Send would refuse before anything is sent, goal first", () => {
    for (const solo of [draft({ loadout: null, ...soloJudge }), thread(soloJudge)]) {
      expect(hint("", solo)).toEqual({
        tone: "warning",
        text: "Write the goal above. Solved when is how the judge checks it.",
      });
      expect(hint(goal, solo)).toEqual({ tone: "warning", text: noJudge });
    }
  });

  it("says what Send does once it can start", () => {
    for (const target of [draft(), thread()]) {
      expect(hint(goal, target)).toEqual({
        tone: "info",
        text: "Send starts it. The budget ends it if nothing passes first.",
      });
    }
  });
});

describe("investigateJudge", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const loadout = (judge?: LoadoutRole): Loadout => ({
    id: "judged",
    name: "Judged",
    description: "",
    roles: judge === undefined ? {} : { judge },
  });
  const providers = [
    { instanceId: codex, displayName: "Codex", enabled: false },
    { instanceId: claude, displayName: "Claude", enabled: true },
  ];

  it("runs a judge when its model or fallback is on a provider enabled for the project", () => {
    expect(investigateJudge(loadout(), providers)).toEqual({ kind: "none" });
    expect(investigateJudge(loadout({ instanceId: claude, model: "opus" }), providers)).toEqual({
      kind: "ready",
    });
    expect(
      investigateJudge(
        loadout({
          instanceId: codex,
          model: "gpt",
          fallback: { instanceId: claude, model: "opus" },
        }),
        providers,
      ),
    ).toEqual({ kind: "ready" });
  });

  it("names the judge's own provider when neither it nor the fallback can run", () => {
    expect(investigateJudge(loadout({ instanceId: codex, model: "gpt" }), providers)).toEqual({
      kind: "off",
      provider: "Codex",
    });
    const gone = ProviderInstanceId.make("gone");
    expect(investigateJudge(loadout({ instanceId: gone, model: "gpt" }), providers)).toEqual({
      kind: "off",
      provider: "gone",
    });
  });

  it("refuses nothing on provider grounds before the provider list arrives", () => {
    expect(investigateJudge(loadout({ instanceId: codex, model: "gpt" }), [])).toEqual({
      kind: "ready",
    });
  });
});

describe("clampParallelApproaches", () => {
  it("snaps typed values into the range the server runs", () => {
    expect(clampParallelApproaches(10)).toBe(8);
    expect(clampParallelApproaches(0)).toBe(1);
    expect(clampParallelApproaches(Number.NaN)).toBe(EMPTY_INVESTIGATE_DRAFT.parallelApproaches);
    expect(clampParallelApproaches(3.6)).toBe(4);
  });
});

describe("runInvestigateSteps", () => {
  it("holds the composer's send guard until the start settles, and stops at the first failure", async () => {
    type Result =
      | { readonly _tag: "Success" }
      | { readonly _tag: "Failure"; readonly cause: string };
    const inFlight = { current: false };
    const ran: string[] = [];
    let settle: (result: Result) => void = () => {};
    const steps = [{ type: "create-thread" }, { type: "start-investigation", start }] as const;
    const pending = runInvestigateSteps<Result>({
      steps,
      inFlight,
      run: (step) => {
        ran.push(step.type);
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    });

    // A Build send, or a second Investigate, from the same draft is refused meanwhile.
    expect(inFlight.current).toBe(true);
    await expect(
      runInvestigateSteps<Result>({
        steps,
        inFlight,
        run: () => Promise.resolve({ _tag: "Success" }),
      }),
    ).resolves.toEqual({ kind: "busy" });

    settle({ _tag: "Failure", cause: "unknown loadout" });
    await expect(pending).resolves.toEqual({
      kind: "failed",
      result: { _tag: "Failure", cause: "unknown loadout" },
    });
    expect(ran).toEqual(["create-thread"]);
    expect(inFlight.current).toBe(false);
  });
});

describe("buildInvestigateStart", () => {
  it("needs a goal, criteria and at least one budget", () => {
    expect(buildInvestigateStart(EMPTY_INVESTIGATE_DRAFT, "  ")).toMatchObject({ ok: false });
    expect(buildInvestigateStart(EMPTY_INVESTIGATE_DRAFT, "Why does sync drop rows?")).toEqual({
      ok: false,
      problem: "Say when the investigation is solved.",
    });
    expect(
      buildInvestigateStart(
        { ...EMPTY_INVESTIGATE_DRAFT, solvedWhen: "A test reproduces it.", minutes: "" },
        "Why?",
      ),
    ).toEqual({ ok: false, problem: "Set a budget in minutes, dollars, or both." });
  });

  it("keeps the criteria verbatim apart from trimming and clamps the approaches", () => {
    expect(
      buildInvestigateStart(
        {
          solvedWhen: "  A failing test passes with the fix.\n",
          minutes: "45",
          usd: "2.50",
          parallelApproaches: 12,
        },
        "Why does sync drop rows?",
      ),
    ).toEqual({
      ok: true,
      goal: "Why does sync drop rows?",
      solvedWhen: "A failing test passes with the fix.",
      budget: { minutes: 45, usd: 2.5 },
      parallelApproaches: 8,
    });
  });

  it("refuses a fractional minute budget", () => {
    expect(
      buildInvestigateStart(
        { ...EMPTY_INVESTIGATE_DRAFT, solvedWhen: "done", minutes: "1.5" },
        "Why?",
      ),
    ).toMatchObject({ ok: false });
  });
});
