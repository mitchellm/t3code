import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as BranchChangeTotalsCache from "./BranchChangeTotalsCache.ts";

type Totals = { readonly insertions: number };

const makeCache = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  return BranchChangeTotalsCache.make<Totals>({ timeout: Duration.seconds(5), scope });
});

describe("BranchChangeTotalsCache", () => {
  it.effect(
    "reuses the stored totals while the key is unchanged and recomputes when it moves",
    () =>
      Effect.gen(function* () {
        const cache = yield* makeCache;
        let computations = 0;
        const compute = Effect.sync(() => ({ insertions: ++computations }));

        const first = yield* cache.read({ cwd: "/repo", key: "head-1", compute });
        const again = yield* cache.read({ cwd: "/repo", key: "head-1", compute });
        const moved = yield* cache.read({ cwd: "/repo", key: "head-2", compute });
        const otherCheckout = yield* cache.read({ cwd: "/other", key: "head-1", compute });

        assert.deepStrictEqual(first, { insertions: 1 });
        assert.deepStrictEqual(again, { insertions: 1 });
        assert.deepStrictEqual(moved, { insertions: 2 });
        assert.deepStrictEqual(otherCheckout, { insertions: 3 });
        assert.strictEqual(computations, 3);
      }),
  );

  it.effect("falls back to the last known totals when the read outlasts the timeout", () =>
    Effect.gen(function* () {
      const cache = yield* makeCache;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let computations = 0;

      const warm = yield* cache.read({
        cwd: "/repo",
        key: "head-1",
        compute: Effect.succeed({ insertions: 7 }),
      });
      assert.deepStrictEqual(warm, { insertions: 7 });

      const slow = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => ({ insertions: 9 + computations++ }))),
      );
      const pending = yield* cache
        .read({ cwd: "/repo", key: "head-2", compute: slow })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.seconds(6));
      assert.deepStrictEqual(yield* Fiber.join(pending), { insertions: 7 });

      // The abandoned read keeps running, so the next read with the same key joins it.
      yield* Deferred.succeed(release, undefined);
      const settled = yield* cache.read({ cwd: "/repo", key: "head-2", compute: slow });
      assert.deepStrictEqual(settled, { insertions: 9 });
      const cached = yield* cache.read({
        cwd: "/repo",
        key: "head-2",
        compute: Effect.die("must be served from the cache"),
      });
      assert.deepStrictEqual(cached, { insertions: 9 });
      assert.strictEqual(computations, 1);
    }),
  );

  it.effect("returns undefined when the first read for a checkout times out or fails", () =>
    Effect.gen(function* () {
      const cache = yield* makeCache;
      const failed = yield* cache.read({
        cwd: "/repo",
        key: "head-1",
        compute: Effect.fail("git failed"),
      });
      assert.strictEqual(failed, undefined);
    }),
  );
});

describe("worktreeFingerprint", () => {
  const withWorktree = <A, E>(
    body: (input: {
      readonly root: string;
      readonly crypto: Crypto.Crypto;
      readonly fileSystem: FileSystem.FileSystem;
      readonly path: Path.Path;
    }) => Effect.Effect<A, E, never>,
  ) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-branch-totals-" });
      return yield* body({ root, crypto, fileSystem, path });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

  it.effect("moves when an untracked file inside a collapsed directory is edited in place", () =>
    withWorktree(({ root, crypto, fileSystem, path }) =>
      Effect.gen(function* () {
        const file = path.join(root, "new-dir", "a.txt");
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        yield* fileSystem.writeFileString(file, "one\n");
        yield* fileSystem.utimes(file, 1_700_000_000, 1_700_000_000);
        const read = () =>
          BranchChangeTotalsCache.worktreeFingerprint({
            crypto,
            fileSystem,
            path,
            root,
            statusStdout: "# branch.oid abc\0? new-dir/\0",
            changedPaths: ["new-dir/"],
          });

        const before = yield* read();
        assert.strictEqual(yield* read(), before);

        // Same size, new mtime: the directory itself and the status record both stay the same.
        yield* fileSystem.writeFileString(file, "two\n");
        yield* fileSystem.utimes(file, 1_700_000_100, 1_700_000_100);
        assert.notStrictEqual(yield* read(), before);
      }),
    ),
  );

  it.effect("moves with HEAD and a tracked edit, and ignores ahead/behind counts", () =>
    withWorktree(({ root, crypto, fileSystem, path }) =>
      Effect.gen(function* () {
        const file = path.join(root, "src.ts");
        yield* fileSystem.writeFileString(file, "a\n");
        yield* fileSystem.utimes(file, 1_700_000_000, 1_700_000_000);
        const read = (statusStdout: string) =>
          BranchChangeTotalsCache.worktreeFingerprint({
            crypto,
            fileSystem,
            path,
            root,
            statusStdout,
            changedPaths: ["src.ts"],
          });
        const modified = "1 .M N... 100644 100644 100644 aa bb src.ts\0";

        const base = yield* read(`# branch.oid head-1\0# branch.ab +0 -0\0${modified}`);
        assert.strictEqual(
          yield* read(`# branch.oid head-1\0# branch.ab +0 -3\0${modified}`),
          base,
        );
        assert.notStrictEqual(
          yield* read(`# branch.oid head-2\0# branch.ab +0 -0\0${modified}`),
          base,
        );

        yield* fileSystem.writeFileString(file, "b\n");
        yield* fileSystem.utimes(file, 1_700_000_100, 1_700_000_100);
        assert.notStrictEqual(
          yield* read(`# branch.oid head-1\0# branch.ab +0 -0\0${modified}`),
          base,
        );

        yield* fileSystem.remove(file);
        const gone = yield* read(`# branch.oid head-1\0${modified}`);
        assert.notStrictEqual(gone, base);
      }),
    ),
  );
});
