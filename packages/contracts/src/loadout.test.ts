import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { LedgerJson } from "./ledger.ts";
import { DEFAULT_LOADOUTS, Loadout, SOLO_LOADOUT_ID } from "./loadout.ts";
import { ProjectSettingsOverrides, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeLoadout = Schema.decodeUnknownSync(Loadout);
const encodeLoadout = Schema.encodeSync(Loadout);
const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeProjectOverrides = Schema.decodeUnknownSync(ProjectSettingsOverrides);
const decodeLedgerJson = Schema.decodeUnknownSync(LedgerJson);

const presetDescriptions = {
  solo: "One agent on the thread's own model. No delegated roles. On single fixes of up to 40 minutes this did as well as a planner with workers and a judge, at half the cost.",
  blitz:
    "Opus plans, Sonnet implements and judges, Haiku reads. Balanced cost for big tasks. Not for a single fix: measured on 5 to 40 minute fixes, a strong planner and judge with Sonnet workers did no better than the strong model alone.",
  "checked-solo":
    "One agent builds on the thread's model; Opus checks the finished work against your message. Measured with a Sonnet builder on hard fixes: 20 of 25 right first time against 7 of 25 unchecked, at about 3 times the cost. On small tasks it only adds cost.",
};

describe("loadout settings", () => {
  it("defaults to the built-in loadouts, solo first", () => {
    const settings = decodeServerSettings({});
    expect(settings.loadouts).toEqual(DEFAULT_LOADOUTS);
    expect(settings.loadouts[0]?.id).toBe(SOLO_LOADOUT_ID);
    expect(settings.loadouts[0]?.roles).toEqual({});
  });

  it("keeps a customised list as stored instead of merging the built-ins back in", () => {
    const custom = {
      id: "mine",
      name: "Mine",
      description: "",
      roles: { worker: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } },
    };
    expect(decodeServerSettings({ loadouts: [custom] }).loadouts).toEqual([custom]);
  });

  it("ships built-ins that decode as loadouts and never name a role twice", () => {
    for (const loadout of DEFAULT_LOADOUTS) {
      expect(decodeLoadout(encodeLoadout(loadout))).toEqual(loadout);
    }
    expect(DEFAULT_LOADOUTS.map(({ id }) => id)).toEqual([
      "solo",
      "opus-blowout",
      "blitz",
      "napalm",
      "haiku-workers",
      "cross-check",
      "checked-solo",
    ]);
    expect(DEFAULT_LOADOUTS[1]?.roles.judge?.model).toBe("claude-opus-5-5");
  });

  it("ships Checked solo as one agent with only an Opus judge, which checks the finished asks", () => {
    const checked = DEFAULT_LOADOUTS.find(({ id }) => id === "checked-solo");
    expect(checked).toEqual({
      id: "checked-solo",
      name: "Checked solo",
      description: presetDescriptions["checked-solo"],
      structure: "solo",
      roles: { judge: { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "high" } },
    });
  });

  it("says what was measured in the descriptions of Solo, Blitz and Checked solo", () => {
    for (const [id, description] of Object.entries(presetDescriptions)) {
      expect(DEFAULT_LOADOUTS.find((loadout) => loadout.id === id)?.description).toBe(description);
    }
  });

  it("judges Cross-check on Codex with an Opus fallback that survives a round trip", () => {
    const judge = DEFAULT_LOADOUTS.find(({ id }) => id === "cross-check")?.roles.judge;
    expect(judge).toMatchObject({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      fallback: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });
  });

  it("decodes a role stored before fallback existed, leaving it unset", () => {
    const decoded = decodeLoadout({
      id: "old",
      name: "Old",
      description: "",
      roles: { judge: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
    });
    expect(decoded.roles.judge).not.toHaveProperty("fallback");
  });

  it("puts Opus on every role of Opus blowout", () => {
    const roles = DEFAULT_LOADOUTS.find(({ id }) => id === "opus-blowout")?.roles ?? {};
    expect(Object.keys(roles).toSorted()).toEqual([
      "explorer",
      "judge",
      "planner",
      "subPlanner",
      "worker",
    ]);
    for (const role of Object.values(roles)) expect(role.model).toBe("claude-opus-5-5");
  });

  it("decodes a settings file that stored the presets, and a project override of them", () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_LOADOUTS)) as unknown;
    expect(decodeServerSettings({ loadouts: stored }).loadouts).toEqual(DEFAULT_LOADOUTS);
    expect(decodeProjectOverrides({ loadouts: stored }).loadouts).toEqual(DEFAULT_LOADOUTS);
  });

  it("accepts loadouts in a settings patch and a project override", () => {
    expect(decodeSettingsPatch({ loadouts: [] }).loadouts).toEqual([]);
    expect(decodeProjectOverrides({ loadouts: DEFAULT_LOADOUTS }).loadouts).toEqual(
      DEFAULT_LOADOUTS,
    );
  });

  // As commit d55a7d14b9 removed them, and as a settings file that saved its list once holds them.
  const plannerWorkersJudge = {
    id: "planner-workers-judge",
    name: "Planner + workers + judge",
    description:
      "A strong planner splits the task, cheaper workers implement, and a separate judge must pass each ledger item before it closes.",
    roles: {
      planner: { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "xhigh" },
      worker: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      judge: { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "high" },
    },
  };
  const readOnlySweep = {
    id: "read-only-sweep",
    name: "Read-only sweep",
    description: "Cheap explorers read and report across the codebase. Nothing is implemented.",
    roles: { explorer: { instanceId: "claudeAgent", model: "claude-haiku-5-5" } },
  };

  it("drops untouched copies of retired presets from saved settings and project overrides", () => {
    const stored = JSON.parse(
      JSON.stringify([
        DEFAULT_LOADOUTS[0],
        plannerWorkersJudge,
        readOnlySweep,
        DEFAULT_LOADOUTS[1],
      ]),
    ) as unknown;
    const kept = [SOLO_LOADOUT_ID, "opus-blowout"];
    expect(decodeServerSettings({ loadouts: stored }).loadouts.map(({ id }) => id)).toEqual(kept);
    expect(decodeProjectOverrides({ loadouts: stored }).loadouts?.map(({ id }) => id)).toEqual(
      kept,
    );
  });

  it("keeps a retired preset the user edited, since it is theirs now", () => {
    const retargeted = {
      ...readOnlySweep,
      roles: { explorer: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } },
    };
    const renamed = { ...plannerWorkersJudge, name: "My planner" };
    expect(decodeServerSettings({ loadouts: [retargeted, renamed] }).loadouts).toEqual([
      retargeted,
      renamed,
    ]);
  });

  // The wording these three presets shipped with before their descriptions said what was measured,
  // as a settings file that saved its list holds them.
  const claudeRole = (model: string, effort?: string) => ({
    instanceId: "claudeAgent",
    model,
    ...(effort === undefined ? {} : { effort }),
  });
  const earlierSolo = {
    id: "solo",
    name: "Solo",
    description: "One agent on the thread's own model. No delegated roles.",
    roles: {},
  };
  const earlierBlitz = {
    id: "blitz",
    name: "Blitz",
    description:
      "Opus plans, Sonnet implements and judges, Haiku reads. Balanced cost for big tasks.",
    roles: {
      planner: claudeRole("claude-opus-5-5", "high"),
      explorer: claudeRole("claude-haiku-5-5"),
      worker: claudeRole("claude-sonnet-5-5"),
      judge: claudeRole("claude-sonnet-5-5"),
    },
  };
  const earlierCheckedSolo = {
    id: "checked-solo",
    name: "Checked solo",
    description:
      "One agent builds on the thread's model; Opus checks the finished work against your message.",
    structure: "solo",
    roles: { judge: claudeRole("claude-opus-5-5", "high") },
  };

  it("upgrades untouched earlier copies of Solo, Blitz and Checked solo to the shipped presets, in place", () => {
    const stored = JSON.parse(
      JSON.stringify([earlierSolo, DEFAULT_LOADOUTS[1], earlierBlitz, earlierCheckedSolo]),
    ) as unknown;
    for (const loadouts of [
      decodeServerSettings({ loadouts: stored }).loadouts,
      decodeProjectOverrides({ loadouts: stored }).loadouts ?? [],
    ]) {
      expect(loadouts.map(({ id }) => id)).toEqual([
        "solo",
        "opus-blowout",
        "blitz",
        "checked-solo",
      ]);
      expect(loadouts.map(({ description }) => description)).toEqual([
        presetDescriptions.solo,
        DEFAULT_LOADOUTS[1]?.description,
        presetDescriptions.blitz,
        presetDescriptions["checked-solo"],
      ]);
      expect(loadouts).toEqual([
        DEFAULT_LOADOUTS[0],
        DEFAULT_LOADOUTS[1],
        DEFAULT_LOADOUTS.find(({ id }) => id === "blitz"),
        DEFAULT_LOADOUTS.find(({ id }) => id === "checked-solo"),
      ]);
    }
  });

  it("keeps a copy of an earlier preset that the user edited", () => {
    const reworded = { ...earlierBlitz, description: `${earlierBlitz.description} My notes.` };
    const retargeted = {
      ...earlierCheckedSolo,
      roles: { judge: claudeRole("claude-sonnet-5-5", "high") },
    };
    const renamed = { ...earlierSolo, name: "Plain" };
    expect(decodeServerSettings({ loadouts: [renamed, reworded, retargeted] }).loadouts).toEqual([
      renamed,
      reworded,
      retargeted,
    ]);
  });
});

describe("ledger requiresJudge", () => {
  const stored = {
    id: "ledger:old",
    threadId: "thread:old",
    title: "Old",
    startState: "",
    checkpoints: [],
    winConditions: [],
    items: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  };

  it("decodes a record written before the field existed, leaving it unset", () => {
    expect(decodeLedgerJson(stored).requiresJudge).toBeUndefined();
    expect(decodeLedgerJson({ ...stored, requiresJudge: true })).toMatchObject({
      requiresJudge: true,
    });
  });
});
