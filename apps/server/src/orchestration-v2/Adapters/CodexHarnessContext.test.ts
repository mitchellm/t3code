import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_LOADOUTS } from "@t3tools/contracts";
import type {
  ProviderAdapterV2HarnessLoadout,
  ProviderAdapterV2HarnessPort,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import { buildCodexChunkedContext } from "../../provider/CodexDeveloperInstructions.ts";
import { codexLoadoutState, readCodexHarnessState } from "./CodexHarnessContext.ts";
import { formatLoadoutBlock, LOADOUT_WITHDRAWN } from "./HarnessHooks.ts";

const crossCheck: ProviderAdapterV2HarnessLoadout = {
  ...DEFAULT_LOADOUTS.find(({ id }) => id === "cross-check")!,
  setBy: "user",
};
const block = formatLoadoutBlock(crossCheck)!;
const holding = (text: string) => buildCodexChunkedContext("loadout_state", text);

describe("codexLoadoutState", () => {
  it("is the block under a loadout, and nothing on a thread that never had one", () => {
    assert.equal(codexLoadoutState(crossCheck, undefined), block);
    assert.isUndefined(codexLoadoutState(null, undefined));
    assert.isUndefined(codexLoadoutState(null, buildCodexChunkedContext("ledger_state", "L1")));
  });

  it("replaces a block with the withdrawal notice once the thread runs solo, and holds it", () => {
    assert.equal(codexLoadoutState(null, holding(block)), LOADOUT_WITHDRAWN);
    // Codex re-sends only a changed value, so holding the notice says it once.
    assert.equal(codexLoadoutState(null, holding(LOADOUT_WITHDRAWN)), LOADOUT_WITHDRAWN);
    assert.equal(codexLoadoutState(crossCheck, holding(LOADOUT_WITHDRAWN)), block);
  });

  it("keeps what Codex holds when the read fails, across chunks", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Role line ${i}: ${"r".repeat(60)}`).join(
      "\n",
    );
    assert.isAbove(Object.keys(holding(long)).length, 1);
    assert.equal(codexLoadoutState(undefined, holding(long)), long);
    assert.isUndefined(codexLoadoutState(undefined, undefined));
  });
});

const port = (loadout: ProviderAdapterV2HarnessLoadout | null): ProviderAdapterV2HarnessPort => ({
  readLedgerState: Effect.succeed({
    ledger: null,
    userInterrupted: false,
    delegatedWorkActive: false,
    pullRequestWatched: false,
  }),
  readThreadPolicy: Effect.die("not read for the turn context"),
  readLoadout: Effect.succeed(loadout),
});

describe("readCodexHarnessState", () => {
  it.effect("sends the loadout only with the T3 tools, which are the only way to its roles", () =>
    Effect.gen(function* () {
      const read = (t3Tools: boolean) =>
        readCodexHarnessState({ harness: port(crossCheck), previous: undefined, t3Tools });
      assert.deepEqual(yield* read(true), { loadoutState: block });
      assert.deepEqual(yield* read(false), {});
    }),
  );
});
