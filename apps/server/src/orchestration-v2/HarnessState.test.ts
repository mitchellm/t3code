import { expect, it } from "@effect/vitest";
import { DEFAULT_LOADOUTS, type Loadout, type LoadoutSetBy, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type HarnessThreadReads, makeHarnessPort } from "./HarnessState.ts";

const split: Loadout = {
  id: "split",
  name: "Split",
  description: "",
  roles: {},
  structure: "managers",
};

const counted = () => {
  const reads = { thread: 0, settings: 0 };
  const threadReads: HarnessThreadReads = {
    readLedgerState: () => Effect.die("not read here"),
    readThreadLoadout: () =>
      Effect.sync(() => {
        reads.thread++;
        return { projectId: ProjectId.make("project"), loadoutId: split.id, setBy: "user" };
      }),
  };
  return { reads, threadReads };
};

it.effect("reads the structure and plan before editing from one thread and settings read", () =>
  Effect.gen(function* () {
    const { reads, threadReads } = counted();
    const port = makeHarnessPort(threadReads, () =>
      Effect.sync(() => {
        reads.settings++;
        return { loadouts: [split], planBeforeEditing: false };
      }),
    );
    expect(yield* port.readThreadPolicy).toEqual({
      structure: "managers",
      planBeforeEditing: false,
      loadout: { ...split, setBy: "user" },
    });
    expect(reads).toEqual({ thread: 1, settings: 1 });
  }),
);

it.effect("carries the thread's loadout and who set it, and nothing when it runs solo", () =>
  Effect.gen(function* () {
    const crossCheck = DEFAULT_LOADOUTS.find(({ id }) => id === "cross-check")!;
    const policyFor = (loadoutId: string | null, setBy: LoadoutSetBy | null) =>
      makeHarnessPort(
        {
          readLedgerState: () => Effect.die("not read here"),
          readThreadLoadout: () =>
            Effect.succeed({ projectId: ProjectId.make("project"), loadoutId, setBy }),
        },
        () => Effect.succeed({ loadouts: DEFAULT_LOADOUTS, planBeforeEditing: true }),
      ).readThreadPolicy;
    expect((yield* policyFor("cross-check", "agent"))?.loadout).toEqual({
      ...crossCheck,
      setBy: "agent",
    });
    // Unset, Solo chosen outright, and a loadout deleted after the thread chose it all run solo.
    for (const [loadoutId, setBy] of [
      [null, null],
      ["solo", "user"],
      ["deleted", "user"],
    ] as const) {
      const policy = yield* policyFor(loadoutId, setBy);
      expect(policy?.structure).toBe("solo");
      expect(policy).not.toHaveProperty("loadout");
    }
  }),
);

it.effect("resolves a failed settings read to undefined, so no hook blocks on it", () =>
  Effect.gen(function* () {
    const { threadReads } = counted();
    const port = makeHarnessPort(threadReads, () => Effect.fail("settings unavailable"));
    expect(yield* port.readThreadPolicy).toBeUndefined();
  }),
);
