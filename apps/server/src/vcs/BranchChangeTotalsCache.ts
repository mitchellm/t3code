import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

const MAX_CACHED_CHECKOUTS = 32;
// Bounds the stat walk below; a larger untracked tree skips the cache and pays the full read.
const MAX_FINGERPRINT_ENTRIES = 2_000;

interface Entry<T> {
  readonly key: string;
  readonly value: T;
}

interface Flight<T> {
  readonly key: string;
  readonly fiber: Fiber.Fiber<Exit.Exit<T, unknown>>;
}

/**
 * Per-checkout memo for the Changes totals, which cost a dozen git runs on a large worktree. A read
 * with an unchanged key returns the stored value. A miss computes in a fiber owned by `scope`, so a
 * caller that stops waiting (timeout, navigation) still lets the result land for the next read.
 */
export function make<T>(options: {
  readonly timeout: Duration.Input;
  readonly scope: Scope.Scope;
}) {
  const entries = new Map<string, Entry<T>>();
  const flights = new Map<string, Flight<T>>();

  const store = (cwd: string, entry: Entry<T>) => {
    entries.delete(cwd);
    entries.set(cwd, entry);
    if (entries.size > MAX_CACHED_CHECKOUTS) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
  };

  /**
   * Resolves to the value for `key`, or to the last value stored for this checkout when the
   * computation is still running after the timeout, or `undefined` when it failed or none exists.
   */
  const read = Effect.fnUntraced(function* <E, R>(input: {
    readonly cwd: string;
    readonly key: string;
    readonly compute: Effect.Effect<T, E, R>;
  }) {
    const { cwd, key } = input;
    const cached = entries.get(cwd);
    if (cached?.key === key) return cached.value;

    let flight = flights.get(cwd);
    if (flight?.key !== key) {
      const started: Flight<T> = {
        key,
        fiber: yield* input.compute.pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              // A newer key replaced this flight; its value is already stale.
              if (flights.get(cwd) === started) store(cwd, { key, value });
            }),
          ),
          Effect.exit,
          Effect.ensuring(
            Effect.sync(() => {
              if (flights.get(cwd) === started) flights.delete(cwd);
            }),
          ),
          // Deferred start: the flight must be registered below before its bookkeeping can run.
          Effect.forkIn(options.scope, { startImmediately: false }),
        ),
      };
      flights.set(cwd, started);
      flight = started;
    }

    const settled = yield* Fiber.join(flight.fiber).pipe(Effect.timeoutOption(options.timeout));
    if (Option.isNone(settled)) return entries.get(cwd)?.value;
    return Exit.isSuccess(settled.value) ? settled.value.value : undefined;
  });

  return { read };
}

/**
 * Working tree state for the cache key: the status records (HEAD oid, index state) plus size and
 * mtime of each changed file, since records carry no content and an index mtime misses unstaged
 * and untracked edits. Undefined when over budget, meaning do not cache.
 */
export const worktreeFingerprint = Effect.fn("BranchChangeTotals.worktreeFingerprint")(
  function* (input: {
    readonly crypto: Crypto.Crypto;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly root: string;
    readonly statusStdout: string;
    readonly changedPaths: Iterable<string>;
    readonly maxEntries?: number;
  }) {
    const parts: Array<string> = [];
    for (const record of input.statusStdout.split("\0")) {
      if (record.length === 0) continue;
      // Ahead/behind counts move on fetch without touching the totals.
      if (record.startsWith("#") && !record.startsWith("# branch.oid ")) continue;
      parts.push(record);
    }

    // Git records a symlink as its target text, so the link is read before the file behind it.
    const signature = Effect.fnUntraced(function* (absolutePath: string) {
      const target = yield* input.fileSystem
        .readLink(absolutePath)
        .pipe(Effect.orElseSucceed(() => null));
      if (target !== null) return `link:${target}`;
      return yield* input.fileSystem.stat(absolutePath).pipe(
        Effect.map(
          (info) => `${info.size}:${Option.getOrElse(Option.map(info.mtime, Number), () => 0)}`,
        ),
        Effect.orElseSucceed(() => "gone"),
      );
    });

    let budget = input.maxEntries ?? MAX_FINGERPRINT_ENTRIES;
    const sign = Effect.fnUntraced(function* (relativePath: string) {
      budget -= 1;
      parts.push(relativePath, yield* signature(input.path.join(input.root, relativePath)));
    });

    // Lists the files under an untracked directory one level at a time and stops as soon as the
    // walk passes the budget. A recursive listing reads the whole tree before the budget can apply,
    // and an untracked folder of checkouts with node_modules holds millions of entries, enough to
    // block the event loop for tens of seconds. Symlinks are signed, never followed.
    const listFiles = Effect.fnUntraced(function* (directory: string) {
      const files: Array<string> = [];
      const pending = [directory];
      let visited = 0;
      while (pending.length > 0) {
        const current = pending.shift() as string;
        const names = yield* input.fileSystem
          .readDirectory(input.path.join(input.root, current))
          .pipe(Effect.orElseSucceed(() => null));
        if (names === null) return null;
        for (const name of names.toSorted()) {
          visited += 1;
          if (visited > budget) return null;
          const child = `${current}${name}`;
          const absolute = input.path.join(input.root, child);
          const isLink = yield* input.fileSystem.readLink(absolute).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          const isDirectory =
            !isLink &&
            (yield* input.fileSystem.stat(absolute).pipe(
              Effect.map((info) => info.type === "Directory"),
              Effect.orElseSucceed(() => false),
            ));
          if (isDirectory) pending.push(`${child}/`);
          else files.push(child);
        }
      }
      return files;
    });

    for (const relativePath of input.changedPaths) {
      if (budget <= 0) return undefined;
      if (!relativePath.endsWith("/")) {
        yield* sign(relativePath);
        continue;
      }
      // Status collapses an untracked directory to one entry; editing a file inside it leaves the
      // directory's own mtime alone, so its files are signed individually.
      const files = yield* listFiles(relativePath);
      if (files === null || files.length > budget) return undefined;
      for (const file of files) yield* sign(file);
    }
    return yield* input.crypto.digest("SHA-256", new TextEncoder().encode(parts.join("\0"))).pipe(
      Effect.map(Hex.encode),
      Effect.orElseSucceed(() => undefined),
    );
  },
);
