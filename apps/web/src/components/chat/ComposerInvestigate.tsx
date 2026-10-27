/**
 * Fork: the composer's Investigate mode. Chosen in the Mode picker, it turns the next send into an
 * investigation: the message is the goal, and these fields say when it is solved and what it may
 * spend. State is per thread or draft and client-only until Start; the server owns the run after.
 */
import { useAtomValue } from "@effect/atom-react";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  INVESTIGATION_MAX_PARALLEL_APPROACHES,
  INVESTIGATION_MIN_PARALLEL_APPROACHES,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { loadoutHasJudge } from "@t3tools/shared/loadouts";
import { AsyncResult } from "effect/reactivity";
import { useId } from "react";
import { create } from "zustand";

import { newMessageId } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatEnvironmentQueryError } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  EMPTY_INVESTIGATE_DRAFT,
  type InvestigateDraft,
  type InvestigateSendStep,
  planInvestigateSend,
} from "./composerInvestigate.logic";
import { resolveComposerMode } from "./composerMode.logic";
import type { draftLaunchLoadout } from "./draftLoadout";

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

/**
 * A thread is in Investigate mode while it has a draft here. A new chat's draft thread id is the
 * id its thread is created with, so the fields carry over when the first send creates it.
 */
const useInvestigateDrafts = create<{
  readonly drafts: Readonly<Record<string, InvestigateDraft>>;
}>(() => ({ drafts: {} }));

function setDraft(key: string, draft: InvestigateDraft | null) {
  useInvestigateDrafts.setState(({ drafts }) => {
    const { [key]: _removed, ...rest } = drafts;
    return { drafts: draft === null ? rest : { ...rest, [key]: draft } };
  });
}

const useInvestigateDraft = (environmentId: EnvironmentId, threadId: ThreadId) =>
  useInvestigateDrafts((state) => state.drafts[threadKey(environmentId, threadId)] ?? null);

export const useInvestigating = (environmentId: EnvironmentId, threadId: ThreadId) =>
  useInvestigateDraft(environmentId, threadId) !== null;

/** Opening keeps fields already typed; closing discards them. */
export function setInvestigating(environmentId: EnvironmentId, threadId: ThreadId, on: boolean) {
  const key = threadKey(environmentId, threadId);
  if (!on) setDraft(key, null);
  else if (useInvestigateDrafts.getState().drafts[key] === undefined) {
    setDraft(key, EMPTY_INVESTIGATE_DRAFT);
  }
}

export const useCanInvestigate = (environmentId: EnvironmentId) =>
  useAtomValue(orchestrationEnvironment.startInvestigation.permissionAtom(environmentId));

/** The fields above the editor while the composer is in Investigate mode. */
export function ComposerInvestigateFields({
  environmentId,
  threadId,
  interactionMode,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  interactionMode: ProviderInteractionMode;
}) {
  const draft = useInvestigateDraft(environmentId, threadId);
  const id = useId();
  if (
    draft === null ||
    resolveComposerMode({ interactionMode, investigating: true }) !== "investigate"
  ) {
    return null;
  }
  const key = threadKey(environmentId, threadId);
  const update = (patch: Partial<InvestigateDraft>) => setDraft(key, { ...draft, ...patch });
  return (
    <div data-composer-investigate className="flex flex-col gap-2 px-3 pt-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-solved`}>Solved when</Label>
        <Textarea
          id={`${id}-solved`}
          size="sm"
          rows={2}
          placeholder="A failing test reproduces the bug and passes with the fix."
          value={draft.solvedWhen}
          onChange={(event) => update({ solvedWhen: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-24 flex-col gap-1">
          <Label htmlFor={`${id}-minutes`}>Minutes</Label>
          <Input
            id={`${id}-minutes`}
            size="sm"
            inputMode="numeric"
            value={draft.minutes}
            onChange={(event) => update({ minutes: event.target.value })}
          />
        </div>
        <div className="flex w-24 flex-col gap-1">
          <Label htmlFor={`${id}-usd`}>Dollars</Label>
          <Input
            id={`${id}-usd`}
            size="sm"
            inputMode="decimal"
            placeholder="none"
            value={draft.usd}
            onChange={(event) => update({ usd: event.target.value })}
          />
        </div>
        <div className="flex w-36 flex-col gap-1">
          <Label htmlFor={`${id}-parallel`}>Parallel approaches</Label>
          <Input
            id={`${id}-parallel`}
            size="sm"
            type="number"
            min={INVESTIGATION_MIN_PARALLEL_APPROACHES}
            max={INVESTIGATION_MAX_PARALLEL_APPROACHES}
            value={draft.parallelApproaches}
            onChange={(event) => update({ parallelApproaches: Number(event.target.value) })}
          />
        </div>
        <p className="pb-1 text-2xs text-muted-foreground">
          Send starts it. The budget ends it if nothing passes first.
        </p>
      </div>
    </div>
  );
}

/** What a new chat's thread is created with when its first send starts an investigation. */
export interface InvestigateDraftThread {
  readonly projectId: ProjectId;
  readonly runtimeMode: RuntimeMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt: string;
  readonly newWorktree: boolean;
  readonly loadout: ReturnType<typeof draftLaunchLoadout>;
}

// A second Send while the first is still creating the thread would create it twice.
const startsInFlight = new Set<string>();

/**
 * For the composer's send path: in Investigate mode, starts the investigation with the prompt as
 * its goal (creating a new chat's thread first) and returns true, so the caller sends nothing
 * else. Returns false in Build and Plan, which send the composer's ordinary turn.
 */
export function useComposerInvestigateSend() {
  const startInvestigation = useAtomCommand(orchestrationEnvironment.startInvestigation, {
    reportFailure: false,
  });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly prompt: string;
    readonly modelSelection: ModelSelection;
    readonly interactionMode: ProviderInteractionMode;
    /** Images, files or attached context: the goal travels as text only. */
    readonly hasAttachments: boolean;
    /** An existing thread's runtime and interaction settings, which the kickoff turn runs under. */
    readonly persistThreadSettings: () => Promise<AtomCommandResult<void, unknown>>;
    /** Set for a new chat, whose thread this send creates. */
    readonly draft: InvestigateDraftThread | null;
    readonly clearPrompt: () => void;
  }): Promise<boolean> => {
    const key = threadKey(input.environmentId, input.threadId);
    const fields = useInvestigateDrafts.getState().drafts[key] ?? null;
    const { draft } = input;
    const plan = planInvestigateSend({
      mode: resolveComposerMode({
        interactionMode: input.interactionMode,
        investigating: fields !== null,
      }),
      fields,
      prompt: input.prompt,
      hasAttachments: input.hasAttachments,
      target:
        draft === null
          ? { kind: "thread" }
          : {
              kind: "draft",
              loadout: draft.loadout.threadLoadout,
              loadoutName: draft.loadout.active.name,
              hasJudge: loadoutHasJudge(draft.loadout.active),
              newWorktree: draft.newWorktree,
            },
    });
    if (plan.kind === "turn") return false;
    if (plan.kind === "refused") {
      toastManager.add({ type: "warning", title: "Not started yet", description: plan.problem });
      return true;
    }
    if (startsInFlight.has(key)) return true;
    const run = (step: InvestigateSendStep): Promise<AtomCommandResult<unknown, unknown>> => {
      const { environmentId, threadId } = input;
      switch (step.type) {
        case "persist-thread-settings":
          return input.persistThreadSettings();
        case "create-thread":
          // Planned only for a draft; an existing thread has nothing to create.
          return draft === null
            ? Promise.resolve(AsyncResult.success(undefined))
            : createThread({
                environmentId,
                input: {
                  threadId,
                  projectId: draft.projectId,
                  title: deriveThreadTitleSeed({ text: input.prompt, attachments: [] }),
                  modelSelection: input.modelSelection,
                  // Investigate is a Build mode: its approaches change code.
                  interactionMode: "default",
                  runtimeMode: draft.runtimeMode,
                  branch: draft.branch,
                  worktreePath: draft.worktreePath,
                  createdAt: draft.createdAt,
                },
              });
        case "set-loadout":
          return updateMetadata({ environmentId, input: { threadId, loadout: step.loadout } });
        case "start-investigation":
          return startInvestigation({
            environmentId,
            input: {
              threadId,
              requestId: newMessageId(),
              ...step.start,
              modelSelection: input.modelSelection,
            },
          });
      }
    };
    startsInFlight.add(key);
    for (const step of plan.steps) {
      const result = await run(step);
      if (result._tag === "Failure") {
        startsInFlight.delete(key);
        toastManager.add({
          type: "error",
          title: "Could not start the investigation",
          description: formatEnvironmentQueryError(result.cause),
        });
        return true;
      }
    }
    startsInFlight.delete(key);
    setDraft(key, null);
    input.clearPrompt();
    return true;
  };
}
