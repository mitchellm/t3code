import { expect, it } from "@effect/vitest";
import { DEFAULT_LOADOUTS, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type LedgerLink,
  readLedgerChain,
  taskLedgerOff,
  taskLedgerOffFor,
} from "./TaskLedgerSwitch.ts";

const link = (extra: Partial<LedgerLink> = {}): LedgerLink => ({
  loadoutId: null,
  hasLedger: false,
  parentThreadId: null,
  ...extra,
});

const settings = (taskLedger: boolean) => ({ taskLedger, loadouts: DEFAULT_LOADOUTS });

it("runs on the ledger while the project's setting is on, whatever the thread is", () => {
  expect(taskLedgerOff(settings(true), [link()])).toBe(false);
  expect(taskLedgerOff(settings(true), [link({ loadoutId: "solo" })])).toBe(false);
});

it("runs without the ledger for a plain thread in a project that turned it off", () => {
  expect(taskLedgerOff(settings(false), [link()])).toBe(true);
  expect(taskLedgerOff(settings(false), [link({ loadoutId: "solo" })])).toBe(true);
  // A loadout deleted after the thread chose it resolves to Solo.
  expect(taskLedgerOff(settings(false), [link({ loadoutId: "deleted" })])).toBe(true);
});

it("keeps the ledger under any loadout with roles or a judge, the Checked solo one included", () => {
  for (const { id } of DEFAULT_LOADOUTS.filter(({ id }) => id !== "solo")) {
    expect(taskLedgerOff(settings(false), [link({ loadoutId: id })]), id).toBe(false);
  }
});

it("keeps the ledger of a thread that already has one, open or closed", () => {
  expect(taskLedgerOff(settings(false), [link({ hasLedger: true })])).toBe(false);
});

it("treats a delegated child as its parent: a roles loadout or a ledger up the chain keeps it", () => {
  const parent = ThreadId.make("parent");
  const child = link({ parentThreadId: parent });
  expect(taskLedgerOff(settings(false), [child, link()])).toBe(true);
  expect(taskLedgerOff(settings(false), [child, link({ loadoutId: "blitz" })])).toBe(false);
  expect(taskLedgerOff(settings(false), [child, link({ hasLedger: true })])).toBe(false);
  expect(taskLedgerOff(settings(false), [link({ ...child, hasLedger: true }), link()])).toBe(false);
});

it.effect("reads nothing about the thread while the setting is on", () =>
  Effect.gen(function* () {
    expect(
      yield* taskLedgerOffFor({
        settings: settings(true),
        readChain: Effect.die("not read while the ledger is on"),
      }),
    ).toBe(false);
    expect(
      yield* taskLedgerOffFor({ settings: settings(false), readChain: Effect.succeed([link()]) }),
    ).toBe(true);
  }),
);

it.effect("walks from the thread to its parents and stops at a top-level thread", () =>
  Effect.gen(function* () {
    const grandparent = ThreadId.make("grandparent");
    const parent = ThreadId.make("parent");
    const child = ThreadId.make("child");
    const links = new Map<ThreadId, LedgerLink>([
      [child, link({ parentThreadId: parent })],
      [parent, link({ parentThreadId: grandparent, loadoutId: "solo" })],
      [grandparent, link({ loadoutId: "blitz" })],
    ]);
    const read: Array<ThreadId> = [];
    const chain = yield* readLedgerChain(child, (id) =>
      Effect.sync(() => {
        read.push(id);
        return links.get(id)!;
      }),
    );
    expect(read).toEqual([child, parent, grandparent]);
    expect(chain.map(({ loadoutId }) => loadoutId)).toEqual([null, "solo", "blitz"]);
    expect(taskLedgerOff(settings(false), chain)).toBe(false);
  }),
);

it.effect("gives up on a chain that never ends, leaving the thread on the ledger", () =>
  Effect.gen(function* () {
    const loop = ThreadId.make("loop");
    const chain = yield* readLedgerChain(loop, () =>
      Effect.succeed(link({ parentThreadId: loop })),
    );
    expect(chain.length).toBeLessThan(20);
    expect(taskLedgerOff(settings(false), chain)).toBe(false);
  }),
);
