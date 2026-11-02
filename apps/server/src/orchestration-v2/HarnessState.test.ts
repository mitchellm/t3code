import { expect, it } from "@effect/vitest";
import {
  DEFAULT_LOADOUTS,
  type Loadout,
  type LoadoutSetBy,
  ProjectId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  type HarnessThreadReads,
  makeHarnessPort,
  makeHarnessThreadReads,
} from "./HarnessState.ts";

const pullRequest = (
  number: number,
  extra: { readonly source?: ThreadPullRequestLink["source"]; readonly watched?: boolean } = {},
) =>
  ({
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: extra.source ?? "agent",
    ...(extra.watched === false ? {} : { watch: { startedAt: "2026-10-27T00:00:00.000Z" } }),
  }) as unknown as ThreadPullRequestLink;

const ledgerStateWith = (pullRequests: ReadonlyArray<ThreadPullRequestLink>) =>
  makeHarnessThreadReads(
    {
      getThreadRecords: () =>
        Effect.succeed({
          thread: { pullRequests },
          ledger: undefined,
          subagents: [],
          runs: [],
          turnItems: [],
        }),
    } as unknown as Parameters<typeof makeHarnessThreadReads>[0],
    ThreadId.make("thread"),
    "Stopped by the user",
  ).readLedgerState();

it.effect("reads a watched pull request as a wait, but not an unwatched or dismissed link", () =>
  Effect.gen(function* () {
    expect((yield* ledgerStateWith([pullRequest(1)])).pullRequestWatched).toBe(true);
    expect(
      (yield* ledgerStateWith([
        pullRequest(2, { watched: false }),
        pullRequest(3, { source: "stack-dismissed" }),
      ])).pullRequestWatched,
    ).toBe(false);
  }),
);

const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 26, 0, minutes));

// A thread whose only ledger finished at minute 10, with the given messages and a stopped run.
const finishedLedgerState = (messages: ReadonlyArray<Record<string, unknown>>) => {
  const reads: Array<ReadonlyArray<string>> = [];
  const state = makeHarnessThreadReads(
    {
      getThreadRecords: (_threadId: unknown, fields: ReadonlyArray<string>) => {
        reads.push(fields);
        if (fields.includes("messages")) return Effect.succeed({ messages });
        return Effect.succeed({
          thread: { pullRequests: [] },
          ledger: {
            title: "Done",
            closedAt: at(10),
            updatedAt: at(10),
            investigation: undefined,
            items: [{ status: "closed", closedAt: at(10), updatedAt: at(10) }],
          },
          subagents: [],
          runs: [{ id: "run-1", status: "completed", completedAt: at(12) }],
          turnItems: [],
        });
      },
    } as unknown as Parameters<typeof makeHarnessThreadReads>[0],
    ThreadId.make("thread"),
    "Stopped by the user",
  ).readLedgerState();
  return { state, reads };
};

const typed = (minutes: number, extra: Record<string, unknown> = {}) => ({
  createdBy: "user",
  creationSource: "web",
  createdAt: at(minutes),
  ...extra,
});

it.effect("reads when a person last typed once the ledger has no open item", () =>
  Effect.gen(function* () {
    const wrote = finishedLedgerState([typed(5), typed(11), typed(8)]);
    expect(DateTime.toEpochMillis((yield* wrote.state).latestUserMessageAt!)).toBe(
      DateTime.toEpochMillis(at(11)),
    );
    // A scheduled run's copy of the user's message is not a person typing.
    const scheduled = finishedLedgerState([typed(11, { scheduledTaskId: "task" })]);
    expect((yield* scheduled.state).latestUserMessageAt).toBeNull();
  }),
);

it.effect("skips the message read while the ledger has an open item", () =>
  Effect.gen(function* () {
    const reads: Array<ReadonlyArray<string>> = [];
    const open = yield* makeHarnessThreadReads(
      {
        getThreadRecords: (_threadId: unknown, fields: ReadonlyArray<string>) => {
          reads.push(fields);
          return Effect.succeed({
            thread: { pullRequests: [] },
            ledger: {
              title: "Doing",
              closedAt: null,
              updatedAt: at(1),
              items: [{ status: "in_progress", closedAt: null, updatedAt: at(1) }],
            },
            subagents: [],
            runs: [],
            turnItems: [],
          });
        },
      } as unknown as Parameters<typeof makeHarnessThreadReads>[0],
      ThreadId.make("thread"),
      "Stopped by the user",
    ).readLedgerState();
    expect(open.latestUserMessageAt).toBeUndefined();
    expect(reads).toHaveLength(1);
  }),
);

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
        return {
          projectId: ProjectId.make("project"),
          loadoutId: split.id,
          setBy: "user",
          runtimeMode: "full-access",
        };
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
      runtimeMode: "full-access",
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
        Effect.succeed({
          projectId: ProjectId.make("project"),
          loadoutId,
          setBy,
          runtimeMode: "full-access" as const,
        }),
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
