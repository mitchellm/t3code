/** Fork: the Research composer mode, which sends the message as a run of T3's research workflow. */
import type { ServerProviderSlashCommand } from "@t3tools/contracts";

/** The workflow the server ships in its Claude plugin; see the server's claudeT3Plugin. */
const RESEARCH_SLASH_COMMAND = "t3:research";

/** Research is offered only where the provider reports the workflow, so it can always run. */
export const researchAvailable = (slashCommands: ReadonlyArray<ServerProviderSlashCommand>) =>
  slashCommands.some((command) => command.name === RESEARCH_SLASH_COMMAND);

/** Lines of the Sources field, without blanks or a pasted bullet. */
export function parseResearchSources(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * The message Research sends. Claude expands a skill only when `/name` starts the text, and the
 * workflow's first step reads the question and sources out of whatever follows, so the sources
 * travel as plain lines. A message that already starts the command is left alone.
 */
export function researchPrompt(prompt: string, sourcesText: string): string {
  const question = prompt.trim();
  if (question.startsWith(`/${RESEARCH_SLASH_COMMAND}`)) return question;
  const sources = parseResearchSources(sourcesText);
  const sourceBlock =
    sources.length === 0
      ? "\n\nNo sources named: search the web."
      : `\n\nSources:\n${sources.map((source) => `- ${source}`).join("\n")}`;
  return `/${RESEARCH_SLASH_COMMAND} ${question}${sourceBlock}`;
}
