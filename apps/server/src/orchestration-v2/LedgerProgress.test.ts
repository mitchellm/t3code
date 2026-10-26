import { assert, describe, it } from "@effect/vitest";
import type { Ledger } from "@t3tools/contracts";

import { summarizeLedgerProgress } from "./LedgerProgress.ts";

const ledgerWith = (statuses: ReadonlyArray<Ledger["items"][number]["status"]>) =>
  ({
    items: statuses.map((status) => ({ status })),
  }) as unknown as Ledger;

describe("summarizeLedgerProgress", () => {
  it("is null without a ledger or without items", () => {
    assert.isNull(summarizeLedgerProgress(undefined));
    assert.isNull(summarizeLedgerProgress(ledgerWith([])));
  });

  it("is null when every item was dropped, since nothing is left to measure", () => {
    assert.isNull(summarizeLedgerProgress(ledgerWith(["dropped", "dropped"])));
  });

  it("counts open and in-progress items as open and leaves dropped ones out of the total", () => {
    assert.deepEqual(
      summarizeLedgerProgress(ledgerWith(["closed", "open", "in_progress", "dropped"])),
      { closed: 1, open: 2, total: 3 },
    );
  });
});
