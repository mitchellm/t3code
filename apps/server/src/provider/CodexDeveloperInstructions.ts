import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T3 Code devices

For iOS Simulators and Android Emulators here, call \`device_list\`, then \`device_open\`. Drive the device with the exact \`agent-device\` launcher and flags it returns, on every command. Prefer \`agent-device snapshot -i\` refs over coordinates. Use \`device_screenshot\` to see the screen. Use \`xcrun simctl\` or \`adb\` only for builds, logs, and ports. If a platform is unavailable, say so.`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * Pinned rules must reach the model verbatim, but Codex silently cuts the middle
 * out of an over-cap value. A long block therefore spans numbered keys, which
 * Codex emits in key order, so the pieces read back as the original text. The
 * short case keeps the bare `pinned_rules` key.
 */
export function buildCodexPinnedRulesContext(
  pinnedRules: string,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  return buildCodexChunkedContext("pinned_rules", pinnedRules);
}

/** Fork: trusted text under `key`, split across numbered keys like pinned rules. */
export function buildCodexChunkedContext(
  key: string,
  text: string,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  if (text === "") return {};
  if (Buffer.byteLength(text) <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
    return { [key]: { kind: "application", value: text } };
  }
  const chunks: Array<string> = [];
  let rest = text;
  while (Buffer.byteLength(rest) > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
    // Longest prefix within the cap, counted in whole characters.
    let end = 0;
    let bytes = 0;
    for (const character of rest) {
      bytes += Buffer.byteLength(character);
      if (bytes > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) break;
      end += character.length;
    }
    // Prefer ending a chunk after a newline so a rule is not cut mid-line.
    const newline = rest.lastIndexOf("\n", end - 1);
    const cut = newline > 0 ? newline + 1 : end;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return Object.fromEntries(
    chunks.map((value, index) => [
      `${key}_${String(index + 1).padStart(2, "0")}`,
      { kind: "application" as const, value },
    ]),
  );
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
