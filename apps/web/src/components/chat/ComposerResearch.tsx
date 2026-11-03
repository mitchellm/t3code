/**
 * Fork: the composer's Research mode. Chosen in the Mode picker, it turns the next send into a run
 * of T3's research workflow: the message is the question and the Sources field says where to look.
 * State is per thread or draft and client-only; the send is an ordinary turn. Plan outranks it
 * while Plan is on, and the Sources field comes back when Plan ends.
 */
import type { EnvironmentId, ProviderInteractionMode, ThreadId } from "@t3tools/contracts";
import { useId } from "react";
import { create } from "zustand";

import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { resolveComposerMode } from "./composerMode.logic";
import { parseResearchSources, researchPrompt } from "./composerResearch.logic";

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

/** A thread is in Research mode while it has an entry here, holding the Sources field's text. */
const useResearchDrafts = create<{ readonly sources: Readonly<Record<string, string>> }>(() => ({
  sources: {},
}));

function setSources(key: string, text: string | null) {
  useResearchDrafts.setState(({ sources }) => {
    const { [key]: _removed, ...rest } = sources;
    return { sources: text === null ? rest : { ...rest, [key]: text } };
  });
}

export const useResearching = (environmentId: EnvironmentId, threadId: ThreadId) =>
  useResearchDrafts((state) => state.sources[threadKey(environmentId, threadId)] !== undefined);

/** Opening keeps sources already typed; closing discards them. */
export function setResearching(environmentId: EnvironmentId, threadId: ThreadId, on: boolean) {
  const key = threadKey(environmentId, threadId);
  if (!on) setSources(key, null);
  else if (useResearchDrafts.getState().sources[key] === undefined) setSources(key, "");
}

/**
 * For the composer's send path: the text to send for this thread. In Research mode it is the
 * research command with the sources, and the mode ends, so a follow-up such as "dig harder on Q2"
 * goes to Claude as an ordinary message about the run.
 */
export function takeResearchPrompt(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  prompt: string,
  interactionMode: ProviderInteractionMode,
): string {
  const key = threadKey(environmentId, threadId);
  const sources = useResearchDrafts.getState().sources[key];
  if (sources === undefined || interactionMode === "plan" || prompt.trim() === "") return prompt;
  setSources(key, null);
  return researchPrompt(prompt, sources);
}

/** The Sources field under the question while the composer is in Research mode. */
export function ComposerResearchFields({
  environmentId,
  threadId,
  interactionMode,
  investigating,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  interactionMode: ProviderInteractionMode;
  investigating: boolean;
}) {
  const id = useId();
  const key = threadKey(environmentId, threadId);
  const sources = useResearchDrafts((state) => state.sources[key]);
  const researching = sources !== undefined;
  if (
    sources === undefined ||
    resolveComposerMode({ interactionMode, investigating, researching }) !== "research"
  ) {
    return null;
  }
  const count = parseResearchSources(sources).length;
  return (
    <div data-composer-research className="flex flex-col gap-1 pt-3">
      <Label htmlFor={`${id}-sources`}>Sources</Label>
      <Textarea
        id={`${id}-sources`}
        size="sm"
        rows={3}
        placeholder={
          "One per line: a file, folder, URL, thread:<id>, or a description\n~/exports/u80\ndocs/saves.md"
        }
        value={sources}
        onChange={(event) => setSources(key, event.target.value)}
      />
      <p className="text-2xs text-muted-foreground">
        {count === 0
          ? "No sources: Send searches the web. Name sources here or in the question."
          : `Send answers from ${count === 1 ? "this source" : `these ${count} sources`}, citing each claim.`}
      </p>
    </div>
  );
}
