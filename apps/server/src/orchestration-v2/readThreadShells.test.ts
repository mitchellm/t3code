import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readThreadShells } from "./readThreadShells.ts";
import type * as ThreadManagement from "./ThreadManagementService.ts";

const shellOf = (id: string) => ({ id: ThreadId.make(id) }) as OrchestrationV2ThreadShell;

const makeThreads = (shells: ReadonlyArray<{ id: string; archived?: boolean }>) => {
  const calls = { single: [] as Array<string>, snapshots: [] as Array<ReadonlyArray<string>> };
  const threads = {
    getThreadShell: (threadId: ThreadId) =>
      Effect.sync(() => {
        calls.single.push(threadId);
        const found = shells.find((shell) => shell.id === threadId);
        return found === undefined ? null : shellOf(found.id);
      }),
    getShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<ThreadId> }) =>
      Effect.sync(() => {
        const ids = options?.threadIds ?? [];
        calls.snapshots.push(ids);
        const matching = shells.filter((shell) => ids.includes(ThreadId.make(shell.id)));
        return {
          schemaVersion: 2,
          snapshotSequence: 1,
          threads: matching.filter((shell) => !shell.archived).map((shell) => shellOf(shell.id)),
          archivedThreads: matching
            .filter((shell) => shell.archived)
            .map((shell) => shellOf(shell.id)),
        };
      }),
  } as unknown as Pick<
    ThreadManagement.ThreadManagementService["Service"],
    "getThreadShell" | "getShellSnapshot"
  >;
  return { threads, calls };
};

it.effect("reads a burst of threads with one snapshot query, archived ones included", () =>
  Effect.gen(function* () {
    const { threads, calls } = makeThreads([{ id: "a" }, { id: "b", archived: true }, { id: "c" }]);
    const ids = ["a", "b", "c", "gone", "a"].map((id) => ThreadId.make(id));
    const shells = yield* readThreadShells(threads, ids);

    assert.deepEqual(calls.snapshots, [["a", "b", "c", "gone"]]);
    assert.deepEqual(calls.single, []);
    assert.equal(shells.get(ThreadId.make("a"))?.id, "a");
    assert.equal(shells.get(ThreadId.make("b"))?.id, "b");
    assert.isNull(shells.get(ThreadId.make("gone")));
  }),
);

it.effect("keeps the single-thread read for one thread and reads nothing for none", () =>
  Effect.gen(function* () {
    const { threads, calls } = makeThreads([{ id: "a" }]);
    const one = yield* readThreadShells(threads, [ThreadId.make("a"), ThreadId.make("a")]);
    assert.equal(one.get(ThreadId.make("a"))?.id, "a");
    yield* readThreadShells(threads, []);

    assert.deepEqual(calls.single, ["a"]);
    assert.deepEqual(calls.snapshots, []);
  }),
);
