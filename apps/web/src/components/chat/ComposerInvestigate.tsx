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
import { useEffect, useId } from "react";
import { create } from "zustand";

import {
  type ComposerThreadTarget,
  type DraftId,
  type DraftThreadEnvMode,
  useComposerDraftStore,
} from "~/composerDraftStore";
import type { ComposerHandleRef } from "~/composerHandleContext";
import { cn, newMessageId } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatEnvironmentQueryError } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { draftSendState } from "./chatViewSend";
import {
  clampParallelApproaches,
  EMPTY_INVESTIGATE_DRAFT,
  type InvestigateDraft,
  investigateHint,
  type InvestigateSendStep,
  planInvestigateSend,
  runInvestigateSteps,
} from "./composerInvestigate.logic";
import { resolveComposerMode, settleComposerMode } from "./composerMode.logic";
import { useDraftLaunchLoadout } from "./useComposerLoadout";

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
  prompt,
  draftId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  interactionMode: ProviderInteractionMode;
  prompt: string;
  /** Set on a new chat, whose first send creates the thread under its loadout. */
  draftId: DraftId | null;
}) {
  const draft = useInvestigateDraft(environmentId, threadId);
  const id = useId();
  const investigating = draft !== null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const draftLoadout = useDraftLaunchLoadout(environmentId, draftSession ? draftId : null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Plan is also entered outside the composer (the proposed-plan card, the server). This component mounts once per composer, so it is where Plan is seen and the fields it outranks end, and leaving Plan lands in Build.
  useEffect(() => {
    const state = { interactionMode, investigating };
    if (settleComposerMode(state) !== state) setInvestigating(environmentId, threadId, false);
  }, [environmentId, threadId, interactionMode, investigating]);
  if (draft === null || resolveComposerMode({ interactionMode, investigating }) !== "investigate") {
    return null;
  }
  const key = threadKey(environmentId, threadId);
  const update = (patch: Partial<InvestigateDraft>) => setDraft(key, { ...draft, ...patch });
  const hint = investigateHint({
    fields: draft,
    prompt,
    target:
      draftSession === null
        ? { kind: "thread" }
        : {
            kind: "draft",
            loadout: draftLoadout.threadLoadout,
            loadoutName: draftLoadout.active.name,
            hasJudge: loadoutHasJudge(draftLoadout.active),
            newWorktree: draftSession.envMode === "worktree" && !draftSession.worktreePath,
          },
  });
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
            onBlur={() =>
              update({ parallelApproaches: clampParallelApproaches(draft.parallelApproaches) })
            }
          />
        </div>
        <p
          className={cn(
            "min-w-0 flex-1 pb-1 text-2xs",
            hint.tone === "warning" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {hint.text}
        </p>
      </div>
    </div>
  );
}

/**
 * What the composer's send path already knows about where it is sending. Its own send input is
 * passed whole, so the call site carries only what changes per send.
 */
export interface InvestigateSendContext {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly activeThread:
    | { readonly id: ThreadId; readonly worktreePath: string | null; readonly createdAt: string }
    | undefined;
  readonly activeThreadBranch: string | null;
  readonly activeProject: { readonly id: ProjectId } | null;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly localCheckoutBranchMismatch: { readonly currentBranch: string } | null;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void;
  readonly resetLocalDispatch: () => void;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * For the composer's send path: in Investigate mode, starts the investigation with the prompt as
 * its goal (creating a new chat's thread first) and returns true, so the caller sends nothing
 * else. Returns false in Build and Plan, which send the composer's ordinary turn.
 */
export function useComposerInvestigateSend(context: InvestigateSendContext) {
  const { environmentId, activeThread, activeProject, isLocalDraftThread, promptRef, composerRef } =
    context;
  const startInvestigation = useAtomCommand(orchestrationEnvironment.startInvestigation, {
    reportFailure: false,
  });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const draftLoadout = useDraftLaunchLoadout(
    environmentId,
    isLocalDraftThread ? context.draftId : null,
  );
  return async (send: {
    readonly prompt: string;
    readonly modelSelection: ModelSelection;
    readonly interactionMode: ProviderInteractionMode;
    /** Images, files or attached context: the goal travels as text only. */
    readonly hasAttachments: boolean;
  }): Promise<boolean> => {
    // A draft that no longer points to a project is the ordinary send's to report.
    const draftProject = isLocalDraftThread ? activeProject : null;
    if (activeThread === undefined || (!context.isServerThread && draftProject === null)) {
      return false;
    }
    const threadId = activeThread.id;
    const key = threadKey(environmentId, threadId);
    const fields = useInvestigateDrafts.getState().drafts[key] ?? null;
    const plan = planInvestigateSend({
      mode: resolveComposerMode({
        interactionMode: send.interactionMode,
        investigating: fields !== null,
      }),
      fields,
      prompt: send.prompt,
      hasAttachments: send.hasAttachments,
      target:
        draftProject === null
          ? { kind: "thread" }
          : {
              kind: "draft",
              loadout: draftLoadout.threadLoadout,
              loadoutName: draftLoadout.active.name,
              hasJudge: loadoutHasJudge(draftLoadout.active),
              newWorktree: context.sendEnvMode === "worktree" && !activeThread.worktreePath,
            },
    });
    if (plan.kind === "turn") return false;
    if (plan.kind === "refused") {
      toastManager.add({ type: "warning", title: "Not started yet", description: plan.problem });
      return true;
    }
    const run = (step: InvestigateSendStep): Promise<AtomCommandResult<unknown, unknown>> => {
      switch (step.type) {
        case "persist-thread-settings":
          return context.persistThreadSettingsForNextTurn({
            threadId,
            createdAt: new Date().toISOString(),
            ...(context.localCheckoutBranchMismatch
              ? { branch: context.localCheckoutBranchMismatch.currentBranch }
              : {}),
            runtimeMode: context.runtimeMode,
            // Investigate is a Build mode: its approaches change code.
            interactionMode: "default",
          });
        case "create-thread":
          // Planned only for a draft; an existing thread has nothing to create.
          return draftProject === null
            ? Promise.resolve(AsyncResult.success(undefined))
            : createThread({
                environmentId,
                input: {
                  threadId,
                  projectId: draftProject.id,
                  title: deriveThreadTitleSeed({ text: send.prompt, attachments: [] }),
                  modelSelection: send.modelSelection,
                  interactionMode: "default",
                  runtimeMode: context.runtimeMode,
                  branch: context.activeThreadBranch,
                  worktreePath: activeThread.worktreePath,
                  createdAt: activeThread.createdAt,
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
              modelSelection: send.modelSelection,
            },
          });
      }
    };
    // The composer's own guard for this thread or draft: any send from it waits for this one.
    const inFlight = draftSendState(context.routeThreadKey).sendInFlight;
    if (inFlight.current) return true;
    // Busy like any send: the button shows it, and the loadout picker keeps the draft's pick.
    context.beginLocalDispatch({ preparingWorktree: false });
    const outcome = await runInvestigateSteps({ steps: plan.steps, inFlight, run });
    if (outcome.kind === "busy") return true;
    if (outcome.kind === "failed") {
      context.resetLocalDispatch();
      toastManager.add({
        type: "error",
        title: "Could not start the investigation",
        description: formatEnvironmentQueryError(outcome.result.cause),
      });
      return true;
    }
    setDraft(key, null);
    promptRef.current = "";
    clearComposerContent(context.composerDraftTarget);
    composerRef.current?.resetCursorState();
    return true;
  };
}
