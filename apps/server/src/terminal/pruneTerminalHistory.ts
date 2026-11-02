import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * History files are only written while their terminal runs, so a file untouched this long belongs
 * to a closed terminal, a deleted thread, or a removed project. Thread deletion removes its own
 * files; this catches the ones that deletion never reached.
 */
export const TERMINAL_HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Deletes `*.log` files in `logsDir` not modified within `maxAgeMs`, skipping `liveFileNames`. */
export const pruneStaleTerminalHistories = Effect.fn("terminal.pruneStaleHistories")(
  function* (input: {
    readonly logsDir: string;
    readonly nowMs: number;
    readonly maxAgeMs: number;
    readonly liveFileNames: ReadonlySet<string>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem
      .readDirectory(input.logsDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    let removed = 0;
    for (const name of entries) {
      if (!name.endsWith(".log") || input.liveFileNames.has(name)) continue;
      const filePath = path.join(input.logsDir, name);
      const modifiedAtMs = yield* fileSystem.stat(filePath).pipe(
        Effect.map((info) =>
          info.type === "File" ? Option.map(info.mtime, (mtime) => mtime.getTime()) : Option.none(),
        ),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      if (Option.isNone(modifiedAtMs) || input.nowMs - modifiedAtMs.value <= input.maxAgeMs) {
        continue;
      }
      const deleted = yield* fileSystem.remove(filePath, { force: true }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to prune terminal history", { name, error }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (deleted) removed += 1;
    }
    if (removed > 0) {
      yield* Effect.logInfo("pruned stale terminal histories", { removed });
    }
    return removed;
  },
);
