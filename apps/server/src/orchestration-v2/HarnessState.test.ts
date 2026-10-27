import { expect, it } from "@effect/vitest";
import { type Loadout, ProjectId } from "@t3tools/contracts";
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
        return { projectId: ProjectId.make("project"), loadoutId: split.id };
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

it.effect("resolves a failed settings read to undefined, so no hook blocks on it", () =>
  Effect.gen(function* () {
    const { threadReads } = counted();
    const port = makeHarnessPort(threadReads, () => Effect.fail("settings unavailable"));
    expect(yield* port.readThreadPolicy).toBeUndefined();
  }),
);
