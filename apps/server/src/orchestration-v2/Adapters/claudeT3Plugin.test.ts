import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CLAUDE_RESEARCH_WORKFLOW } from "./claudeResearchWorkflow.ts";
import { CLAUDE_T3_PLUGIN_NAME, ensureClaudeT3Plugin } from "./claudeT3Plugin.ts";

it.layer(NodeServices.layer)("claudeT3Plugin", (it) => {
  describe("ensureClaudeT3Plugin", () => {
    it.effect("writes the plugin manifest and research workflow, and repairs a changed file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-plugin-" });

        const pluginDir = yield* ensureClaudeT3Plugin(stateDir);
        const manifest = JSON.parse(
          yield* fileSystem.readFileString(path.join(pluginDir, ".claude-plugin", "plugin.json")),
        );
        const workflowPath = path.join(pluginDir, "workflows", "research.js");
        expect(manifest.name).toBe(CLAUDE_T3_PLUGIN_NAME);
        expect(yield* fileSystem.readFileString(workflowPath)).toBe(CLAUDE_RESEARCH_WORKFLOW);

        yield* fileSystem.writeFileString(workflowPath, "stale");
        expect(yield* ensureClaudeT3Plugin(stateDir)).toBe(pluginDir);
        expect(yield* fileSystem.readFileString(workflowPath)).toBe(CLAUDE_RESEARCH_WORKFLOW);
      }),
    );
  });

  it("ships a research workflow Claude Code can parse", () => {
    // Claude Code runs the body after `export const meta` as an async function with these hooks.
    const body = CLAUDE_RESEARCH_WORKFLOW.replace("export const meta", "const meta");
    expect(CLAUDE_RESEARCH_WORKFLOW.startsWith("export const meta = {")).toBe(true);
    expect(
      () =>
        new Function(
          "args",
          "agent",
          "parallel",
          "pipeline",
          "phase",
          "log",
          "budget",
          `return (async () => {${body}\n})`,
        ),
    ).not.toThrow();
  });
});
