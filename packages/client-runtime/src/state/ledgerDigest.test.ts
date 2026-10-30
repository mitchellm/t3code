import { describe, expect, it } from "@effect/vitest";

import { digestLedgerText } from "./ledgerDigest.ts";

const headlineOf = (text: string) => digestLedgerText(text)?.headline;
const factsOf = (text: string) => digestLedgerText(text)?.facts ?? [];

describe("digestLedgerText", () => {
  describe("input", () => {
    it("returns null for null, undefined and blank text", () => {
      expect(digestLedgerText(null)).toBeNull();
      expect(digestLedgerText(undefined)).toBeNull();
      expect(digestLedgerText("")).toBeNull();
      expect(digestLedgerText("  \n\t ")).toBeNull();
    });

    it("returns a headline with no facts or truncation for plain short text", () => {
      expect(digestLedgerText("Everything works.")).toEqual({
        headline: "Everything works",
        facts: [],
        moreFacts: 0,
        truncated: false,
      });
    });
  });

  describe("headline", () => {
    it("ends the first sentence at . ! ? ; or a newline", () => {
      expect(headlineOf("The panel renders the digest. Then more follows here.")).toBe(
        "The panel renders the digest",
      );
      expect(headlineOf("The panel renders the digest! Then more follows here.")).toBe(
        "The panel renders the digest",
      );
      expect(headlineOf("Does the panel render the digest? Then more follows.")).toBe(
        "Does the panel render the digest",
      );
      expect(headlineOf("The panel renders the digest; then more follows here.")).toBe(
        "The panel renders the digest",
      );
      expect(headlineOf("The panel renders the digest\nand then more follows here.")).toBe(
        "The panel renders the digest",
      );
    });

    it("does not split inside file names, versions or numbers", () => {
      expect(headlineOf("Updated ledgerPanel.ts to read the new field. Second part.")).toBe(
        "Updated ledgerPanel.ts to read the new field",
      );
      expect(headlineOf("Released v0.1.3 with the digest pane. Second part.")).toBe(
        "Released v0.1.3 with the digest pane",
      );
      expect(headlineOf("The run took 1.5s end to end on this machine. Second part.")).toBe(
        "The run took 1.5s end to end on this machine",
      );
    });

    it("strips markdown", () => {
      expect(headlineOf("## **Fixed** the `ledgerPanel.ts` bug in *three* places")).toBe(
        "Fixed the ledgerPanel.ts bug in three places",
      );
      expect(headlineOf("- Read the [design doc](https://example.com/doc) before shipping")).toBe(
        "Read the design doc before shipping",
      );
      expect(headlineOf("1. Wired the pane into the sidebar for every thread")).toBe(
        "Wired the pane into the sidebar for every thread",
      );
      expect(headlineOf("* Wired the pane into the sidebar for every thread")).toBe(
        "Wired the pane into the sidebar for every thread",
      );
    });

    it("collapses whitespace", () => {
      expect(headlineOf("  Wired   the\tpane   into the sidebar  ")).toBe(
        "Wired the pane into the sidebar",
      );
    });

    it("caps long headlines at 180 characters on a word boundary with an ellipsis", () => {
      const digest = digestLedgerText(`${"word ".repeat(80)}end`);
      expect(digest?.headline.length).toBeLessThanOrEqual(180);
      expect(digest?.headline.endsWith("…")).toBe(true);
      expect(digest?.headline.slice(0, -1).endsWith("word")).toBe(true);
      expect(digest?.truncated).toBe(true);
    });

    it("does not touch a headline of exactly the cap length", () => {
      const text = `${"a".repeat(89)} ${"b".repeat(90)}`;
      expect(text).toHaveLength(180);
      expect(headlineOf(text)).toBe(text);
    });

    it("appends the next sentence when the first is very short", () => {
      expect(headlineOf("Done. Added the digest function and wired it into the pane.")).toBe(
        "Done. Added the digest function and wired it into the pane",
      );
    });

    it("keeps a short first sentence alone when nothing follows", () => {
      expect(headlineOf("Done.")).toBe("Done");
    });
  });

  describe("truncated", () => {
    it("is false when the headline covers the whole text", () => {
      expect(digestLedgerText("Everything works")?.truncated).toBe(false);
      expect(digestLedgerText("Done. Tests green.")?.truncated).toBe(false);
    });

    it("is true when more text follows the headline", () => {
      expect(
        digestLedgerText("The panel renders the digest. Then more follows here.")?.truncated,
      ).toBe(true);
    });
  });

  describe("commit facts", () => {
    it("extracts a commit sha with a seven character label", () => {
      expect(
        factsOf("Committed as 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b on the branch"),
      ).toEqual([
        {
          kind: "commit",
          label: "1a2b3c4",
          value: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        },
      ]);
      expect(factsOf("Landed in 808cff3eae today")).toEqual([
        { kind: "commit", label: "808cff3", value: "808cff3eae" },
      ]);
    });

    it("ignores ordinary words, digit-only runs and hex without a digit", () => {
      expect(factsOf("We added a facade over a decade of deadbeef feedface code")).toEqual([]);
      expect(factsOf("Counted 1234567 rows")).toEqual([]);
    });

    it("ignores hex that is part of a path or url", () => {
      expect(factsOf("Saw src/abc1234/readme.txt and https://example.com/abc1234def")).toEqual([
        {
          kind: "file",
          label: "readme.txt",
          value: "src/abc1234/readme.txt",
        },
      ]);
    });
  });

  describe("file facts", () => {
    it("extracts a path with its line and labels it with the basename", () => {
      expect(
        factsOf("See packages/client-runtime/src/state/ledgerPanel.ts:120 for the change"),
      ).toEqual([
        {
          kind: "file",
          label: "ledgerPanel.ts:120",
          value: "packages/client-runtime/src/state/ledgerPanel.ts:120",
        },
      ]);
    });

    it("handles plain paths, line columns, line ranges and backslashes", () => {
      expect(factsOf("Touched apps/web/src/App.tsx.")).toEqual([
        { kind: "file", label: "App.tsx", value: "apps/web/src/App.tsx" },
      ]);
      expect(factsOf("At apps/web/src/App.tsx:10:4 it failed")[0]?.label).toBe("App.tsx:10");
      expect(factsOf("At apps/web/src/App.tsx:10-20 it failed")[0]).toEqual({
        kind: "file",
        label: "App.tsx:10",
        value: "apps/web/src/App.tsx:10-20",
      });
      expect(factsOf("Edited C:\\work\\t3code\\ChatView.tsx now")).toEqual([
        { kind: "file", label: "ChatView.tsx", value: "C:\\work\\t3code\\ChatView.tsx" },
      ]);
    });

    it("extracts a bare basename only when a line follows", () => {
      expect(factsOf("Look at ChatView.tsx:120 closely")).toEqual([
        { kind: "file", label: "ChatView.tsx:120", value: "ChatView.tsx:120" },
      ]);
      expect(factsOf("Updated ledgerPanel.ts to read the field")).toEqual([]);
    });

    it("finds paths inside backticks and links", () => {
      expect(
        factsOf("Changed `src/a/b.ts` and [the file](src/c/d.ts)").map((f) => f.label),
      ).toEqual(["b.ts", "d.ts"]);
    });

    it("ignores versions and durations", () => {
      expect(factsOf("Released v0.1.3 after 1.5s")).toEqual([]);
    });
  });

  describe("test facts", () => {
    it("extracts passed counts in the common phrasings", () => {
      for (const text of [
        "14 passed",
        "14 tests passed",
        "14/14 pass",
        "Tests 14 passed (14)",
        "All good: 14 passing",
      ]) {
        expect(factsOf(text), text).toEqual([
          { kind: "tests", label: "14 passed", value: expect.any(String), tone: "success" },
        ]);
      }
    });

    it("adds an error chip only when something failed", () => {
      expect(factsOf("14 passed, 3 failed")).toEqual([
        { kind: "tests", label: "14 passed", value: "14 passed", tone: "success" },
        { kind: "tests", label: "3 failed", value: "3 failed", tone: "error" },
      ]);
      expect(factsOf("14 passed, 0 failed").map((f) => f.label)).toEqual(["14 passed"]);
    });

    it("merges repeated pass counts into one chip using the largest", () => {
      expect(factsOf("Test Files 2 passed (2), Tests 14 passed (14)").map((f) => f.label)).toEqual([
        "14 passed",
      ]);
    });
  });

  describe("pr facts", () => {
    it("extracts PR references and pull urls", () => {
      expect(factsOf("Opened PR #1234 for review")).toEqual([
        { kind: "pr", label: "PR #1234", value: "#1234" },
      ]);
      expect(factsOf("Merged pull request #77")[0]?.label).toBe("PR #77");
      expect(factsOf("#42 is the one")[0]?.label).toBe("PR #42");
      expect(factsOf("See https://github.com/acme/repo/pull/99 now")).toEqual([
        {
          kind: "pr",
          label: "PR #99",
          value: "https://github.com/acme/repo/pull/99",
        },
      ]);
    });

    it("ignores a bare hash number elsewhere in a sentence", () => {
      expect(factsOf("Fixed issue #12 in the parser")).toEqual([]);
    });
  });

  describe("fact list", () => {
    it("orders facts by first appearance", () => {
      expect(
        factsOf("Ran 14 passed in a/b.ts:5 then committed abc1234 under PR #8").map((f) => f.kind),
      ).toEqual(["tests", "file", "commit", "pr"]);
    });

    it("dedupes facts by value", () => {
      expect(
        factsOf("a/b.ts:5 then a/b.ts:5 again, commit abc1234 and abc1234, PR #8 and PR #8"),
      ).toHaveLength(3);
    });

    it("caps facts at six and reports the excess", () => {
      const files = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`).join(" ");
      const digest = digestLedgerText(`Touched ${files}`);
      expect(digest?.facts.map((f) => f.label)).toEqual([
        "file0.ts",
        "file1.ts",
        "file2.ts",
        "file3.ts",
        "file4.ts",
        "file5.ts",
      ]);
      expect(digest?.moreFacts).toBe(3);
    });
  });
});
