/**
 * Fork: the composer's Investigate mode. Beside Build/Plan, it turns the next send into an
 * investigation: the message is the goal, and these fields say when it is solved and what it may
 * spend. State is per thread and client-only until Start; the server owns the run after that.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  INVESTIGATION_MAX_PARALLEL_APPROACHES,
  INVESTIGATION_MIN_PARALLEL_APPROACHES,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { FlaskConicalIcon } from "lucide-react";
import { useId } from "react";
import { create } from "zustand";

import { newMessageId } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import {
  buildInvestigateStart,
  EMPTY_INVESTIGATE_DRAFT,
  type InvestigateDraft,
} from "./composerInvestigate.logic";

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

/** A thread is in Investigate mode while it has a draft here. */
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

export function ComposerInvestigateToggle({
  environmentId,
  threadId,
  size,
  hidden,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  size: "sm" | "xs";
  hidden: boolean;
}) {
  const draft = useInvestigateDraft(environmentId, threadId);
  const canStart = useAtomValue(
    orchestrationEnvironment.startInvestigation.permissionAtom(environmentId),
  );
  if (hidden || !canStart) return null;
  const active = draft !== null;
  const label = active
    ? "Investigate mode. Click to send a normal message instead"
    : "Investigate: run parallel approaches until one meets your criteria";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0 whitespace-nowrap"
            aria-pressed={active}
            type="button"
            onClick={() =>
              setDraft(threadKey(environmentId, threadId), active ? null : EMPTY_INVESTIGATE_DRAFT)
            }
            aria-label={label}
          />
        }
      >
        <ComposerControlIcon icon={FlaskConicalIcon} size={size} />
        <span data-composer-control-label className="sr-only sm:not-sr-only">
          Investigate
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The fields above the editor while the thread is in Investigate mode. */
export function ComposerInvestigateFields({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const draft = useInvestigateDraft(environmentId, threadId);
  const id = useId();
  if (draft === null) return null;
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

/**
 * For the composer's send path: when the thread is in Investigate mode, starts the investigation
 * with the prompt as its goal and returns true, so the caller sends nothing else.
 */
export function useComposerInvestigateSend() {
  const startInvestigation = useAtomCommand(orchestrationEnvironment.startInvestigation, {
    reportFailure: false,
  });
  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly prompt: string;
    readonly modelSelection: ModelSelection;
    readonly clearPrompt: () => void;
  }): Promise<boolean> => {
    const key = threadKey(input.environmentId, input.threadId);
    const draft = useInvestigateDrafts.getState().drafts[key];
    if (draft === undefined) return false;
    const start = buildInvestigateStart(draft, input.prompt);
    if (!start.ok) {
      toastManager.add({ type: "warning", title: "Not started yet", description: start.problem });
      return true;
    }
    const result = await startInvestigation({
      environmentId: input.environmentId,
      input: {
        threadId: input.threadId,
        requestId: newMessageId(),
        goal: start.goal,
        solvedWhen: start.solvedWhen,
        budget: start.budget,
        parallelApproaches: start.parallelApproaches,
        modelSelection: input.modelSelection,
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not start the investigation",
        description: formatEnvironmentQueryError(result.cause),
      });
      return true;
    }
    setDraft(key, null);
    input.clearPrompt();
    return true;
  };
}
