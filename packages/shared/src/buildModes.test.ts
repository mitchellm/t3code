import { describe, expect, it } from "vite-plus/test";

import { buildModeAvailability, providerSupportsCompaction } from "./buildModes.ts";

const COMPACT = { name: "compact" };

// What each driver's provider snapshot advertises today (see the COMPACT_SLASH_COMMAND users and
// the per-driver status modules). Antigravity and ACP registry agents advertise whatever the agent
// reports, so they are listed with and without it.
const SNAPSHOT_SLASH_COMMANDS = {
  claudeAgent: [COMPACT, { name: "review" }],
  codex: [COMPACT],
  opencode: [COMPACT],
  grok: [COMPACT],
  pi: [COMPACT],
  muse: [COMPACT],
  cursor: [],
  antigravityWithoutCompact: [{ name: "help" }],
} as const;

describe("buildModeAvailability", () => {
  it.each([
    ["claudeAgent", true],
    ["codex", true],
    ["opencode", true],
    ["grok", true],
    ["pi", true],
    ["muse", true],
    ["cursor", false],
    ["antigravityWithoutCompact", false],
  ] as const)("offers Compact and build on %s only with a compact command: %s", (driver, ok) => {
    const availability = buildModeAvailability({
      hasWork: true,
      compactSupported: providerSupportsCompaction(SNAPSHOT_SLASH_COMMANDS[driver]),
      judgeConfigured: false,
    });
    expect(availability.compact_and_build === null).toBe(ok);
    // Build and Reset ride paths every adapter has: a turn, and a first turn on a new native thread.
    expect(availability.build).toBeNull();
    expect(availability.reset_and_build).toBeNull();
  });

  it("offers Audit only under a loadout with a judge", () => {
    expect(
      buildModeAvailability({ hasWork: true, compactSupported: true, judgeConfigured: false })
        .audit,
    ).toBe("The thread's loadout has no judge role.");
    expect(
      buildModeAvailability({ hasWork: true, compactSupported: true, judgeConfigured: true }).audit,
    ).toBeNull();
  });

  it("offers nothing without a plan or a planning ledger to build", () => {
    const availability = buildModeAvailability({
      hasWork: false,
      compactSupported: true,
      judgeConfigured: true,
    });
    expect(Object.values(availability).every((reason) => reason !== null)).toBe(true);
  });
});
