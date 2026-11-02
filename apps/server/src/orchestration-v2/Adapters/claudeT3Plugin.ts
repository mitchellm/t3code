import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import { CLAUDE_RESEARCH_WORKFLOW } from "./claudeResearchWorkflow.ts";

export const CLAUDE_T3_PLUGIN_NAME = "t3";

// Claude Code loads plugins only from a directory, so T3 writes its own under its state directory
// and passes it to every Claude session it starts. Atomic writes keep a session that opens while a
// second server instance rewrites the files from reading half a script.
const CLAUDE_T3_PLUGIN_FILES: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [
    [".claude-plugin", "plugin.json"],
    `${JSON.stringify(
      {
        name: CLAUDE_T3_PLUGIN_NAME,
        version: "1.0.0",
        description: "Workflows that ship with T3 Code.",
      },
      null,
      2,
    )}\n`,
  ],
  [["workflows", "research.js"], CLAUDE_RESEARCH_WORKFLOW],
];

export const ensureClaudeT3Plugin = Effect.fn("ensureClaudeT3Plugin")(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginDir = path.join(stateDir, "claude-plugin");
  for (const [segments, contents] of CLAUDE_T3_PLUGIN_FILES) {
    const filePath = path.join(pluginDir, ...segments);
    const current = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (current !== contents) yield* writeFileStringAtomically({ filePath, contents });
  }
  return pluginDir;
});
