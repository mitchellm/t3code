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
    });
    expect(reads).toEqual({ thread: 1, settings: 1 });
  }),
);

const crossCheck = DEFAULT_LOADOUTS.find(({ id }) => id === "cross-check")!;
// Roles, but the user chose the solo structure for it.
const soloWithRoles: Loadout = { ...crossCheck, id: "solo-with-roles", structure: "solo" };

const loadoutPort = (loadoutId: string | null, setBy: LoadoutSetBy | null) => {
  const reads = { settings: 0 };
  const port = makeHarnessPort(
    {
      readLedgerState: () => Effect.die("not read here"),
      readThreadLoadout: () =>
        Effect.succeed({ projectId: ProjectId.make("project"), loadoutId, setBy }),
    },
    () =>
      Effect.sync(() => {
        reads.settings++;
        return { loadouts: [...DEFAULT_LOADOUTS, soloWithRoles], planBeforeEditing: true };
      }),
  );
  return { reads, port };
};

it.effect("reads the thread's loadout and who set it, and null when it runs solo", () =>
  Effect.gen(function* () {
    expect(yield* loadoutPort("cross-check", "agent").port.readLoadout).toEqual({
      ...crossCheck,
      setBy: "agent",
    });
    // Solo chosen outright, a loadout deleted after the thread chose it, and a loadout with roles
    // whose structure is solo all run solo.
    for (const loadoutId of ["solo", "deleted", soloWithRoles.id]) {
      expect(yield* loadoutPort(loadoutId, "user").port.readLoadout).toBeNull();
    }
  }),
);

it.effect("reads no settings for a thread with no loadout, since every turn reads it", () =>
  Effect.gen(function* () {
    const none = loadoutPort(null, null);
    expect(yield* none.port.readLoadout).toBeNull();
    expect(none.reads.settings).toBe(0);
    const set = loadoutPort("cross-check", "user");
    yield* set.port.readLoadout;
    expect(set.reads.settings).toBe(1);
  }),
);

it.effect("resolves a failed settings read to undefined, so no hook blocks on it", () =>
  Effect.gen(function* () {
    const { threadReads } = counted();
    const port = makeHarnessPort(threadReads, () => Effect.fail("settings unavailable"));
    expect(yield* port.readThreadPolicy).toBeUndefined();
    expect(yield* port.readLoadout).toBeUndefined();
  }),
);
