// @effect-diagnostics nodeBuiltinImport:off - utimes sets a file's age, which the Effect FileSystem cannot do before the files exist.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  pruneStaleTerminalHistories,
  TERMINAL_HISTORY_MAX_AGE_MS,
} from "./pruneTerminalHistory.ts";

const NOW_MS = Date.parse("2026-11-02T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

it.layer(NodeServices.layer)("pruneStaleTerminalHistories", (it) => {
  it.effect("removes histories untouched for 14 days and keeps recent and live ones", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-terminal-prune-" });
      const write = (name: string, ageDays: number) => {
        const filePath = path.join(logsDir, name);
        NodeFS.writeFileSync(filePath, "history");
        const at = (NOW_MS - ageDays * DAY_MS) / 1000;
        NodeFS.utimesSync(filePath, at, at);
      };
      write("terminal_old-project.log", 25);
      write("terminal_old-project_extra.log", 17);
      write("terminal_just-over.log", 14.01);
      write("terminal_just-under.log", 13.9);
      write("terminal_recent.log", 0.1);
      write("terminal_live-but-idle.log", 40);
      write("notes.txt", 90);
      NodeFS.mkdirSync(path.join(logsDir, "terminal_old-directory.log"));

      const removed = yield* pruneStaleTerminalHistories({
        logsDir,
        nowMs: NOW_MS,
        maxAgeMs: TERMINAL_HISTORY_MAX_AGE_MS,
        liveFileNames: new Set(["terminal_live-but-idle.log"]),
      });

      assert.equal(removed, 3);
      assert.deepEqual(NodeFS.readdirSync(logsDir).toSorted(), [
        "notes.txt",
        "terminal_just-under.log",
        "terminal_live-but-idle.log",
        "terminal_old-directory.log",
        "terminal_recent.log",
      ]);
    }),
  );

  it.effect("does nothing when the logs directory is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-terminal-prune-" });
      const removed = yield* pruneStaleTerminalHistories({
        logsDir: path.join(root, "absent"),
        nowMs: NOW_MS,
        maxAgeMs: TERMINAL_HISTORY_MAX_AGE_MS,
        liveFileNames: new Set(),
      });
      assert.equal(removed, 0);
    }),
  );
});
