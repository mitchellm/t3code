import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  heapUsedBytes: 512 * 1024 * 1024,
  elapsedMs: 30_000,
  loadAverage: 219.43,
  cpuCount: 18,
};

describe("EventLoopMonitor stall profile", () => {
  it.effect("writes a cpuprofile for a stalled window and none for a calm one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stall-profile-" });
      const logPath = path.join(directory, "event-loop-stalls.ndjson");
      let current: EventLoopMonitor.EventLoopReadings = { ...stalled, delayMaxNs: ms(1_050) };
      const profile = { nodes: [], samples: [], startTime: 0, endTime: 1 };
      const layer = EventLoopMonitor.layerWith(
        Effect.succeed(Effect.sync(() => current)),
        { filePath: logPath, maxBytes: 1_000_000 },
        Effect.succeed({ rotate: Effect.succeed(profile) }),
      );

      yield* Effect.gen(function* () {
        const monitor = yield* EventLoopMonitor.EventLoopMonitor;
        // The first window is skipped as startup; the next one is a real tick.
        yield* TestClock.adjust("30 seconds");
        yield* monitor.latestNoticeableStall;
        const profilesAfterCalm = (yield* fs.readDirectory(directory)).filter((name) =>
          name.endsWith(".cpuprofile"),
        );
        assert.deepStrictEqual(profilesAfterCalm, []);

        current = stalled;
        yield* monitor.latestNoticeableStall;
        const profiles = (yield* fs.readDirectory(directory)).filter((name) =>
          name.endsWith(".cpuprofile"),
        );
        assert.strictEqual(profiles.length, 1);
        const line = JSON.parse((yield* fs.readFileString(logPath)).trim());
        assert.strictEqual(line.cpuProfile, path.join(directory, profiles[0]!));
        assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(line.cpuProfile)), profile);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("EventLoopMonitor", () => {
  it("ignores delay the loop spent idle, such as a system sleep", () => {
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_000);
  });
});
