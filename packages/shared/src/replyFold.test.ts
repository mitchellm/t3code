import { describe, expect, it } from "vite-plus/test";

import { foldLongReply } from "./replyFold.ts";

const sentence = (n: number) => `Sentence ${n} has exactly seven words here.`;
const paragraph = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");
const headOf = (folded: string) => folded.split("\n\n<details>")[0];

describe("foldLongReply", () => {
  it("leaves short replies alone", () => {
    const reply = `Merged #57: reconnect test fixed.\n\n${paragraph(0, 4)}`;
    expect(foldLongReply(reply)).toBe(reply);
  });

  it("shows the headline and folds the rest under a word count", () => {
    const reply = [
      "Merged #57: reconnect test fixed, 20/20 runs pass.",
      paragraph(0, 10),
      paragraph(10, 5),
    ].join("\n\n");
    const result = foldLongReply(reply);
    expect(headOf(result)).toBe("Merged #57: reconnect test fixed, 20/20 runs pass.");
    expect(result).toContain("<summary>More · 105 words</summary>\n\n");
    expect(result.trimEnd().endsWith(`${paragraph(10, 5)}\n\n</details>`)).toBe(true);
  });

  it("keeps a Needs you block and a short link line with the headline", () => {
    const needs =
      "Needs you: pick a fix.\n- A (my pick): own base damage\n- B: copy the uncapped pet";
    const reply = [
      "Mostly by design; one real bug in large pets.",
      needs,
      "PR: https://github.com/acme/app/pull/42",
      paragraph(0, 12),
    ].join("\n\n");
    expect(headOf(foldLongReply(reply))).toBe(
      `Mostly by design; one real bug in large pets.\n\n${needs}\n\nPR: https://github.com/acme/app/pull/42`,
    );
  });

  it("keeps at most five short action lines under a Needs you headline", () => {
    const decisions = Array.from({ length: 7 }, (_, i) => `- Decision ${i}: ship it (my pick)`);
    const reply = ["Needs you: seven calls before launch.", ...decisions, paragraph(0, 10)].join(
      "\n",
    );
    expect(headOf(foldLongReply(reply))).toBe(
      ["Needs you: seven calls before launch.", ...decisions.slice(0, 5)].join("\n"),
    );
  });

  it("splits a long opening paragraph after its first sentence", () => {
    const opening = `The page is live and loads every topic from the last thirty days of data. ${paragraph(0, 10)}`;
    const reply = [opening, paragraph(10, 5)].join("\n\n");
    const result = foldLongReply(reply);
    expect(headOf(result)).toBe(
      "The page is live and loads every topic from the last thirty days of data.",
    );
    expect(result).toContain(paragraph(0, 10));
  });

  it("takes the line after a title so the headline is never just a heading", () => {
    const reply = ["## Rundown", "Twelve tracks is normal for an event.", paragraph(0, 12)].join(
      "\n\n",
    );
    expect(headOf(foldLongReply(reply))).toBe(
      "## Rundown\n\nTwelve tracks is normal for an event.",
    );
  });

  it("leaves a reply whose own fold sits under a short headline", () => {
    const reply = `Merged #57.\n\n<details><summary>Details</summary>\n\n${paragraph(0, 20)}\n\n</details>`;
    expect(foldLongReply(reply)).toBe(reply);
  });

  it("refolds a long head above the reply's own fold into one fold", () => {
    const reply = `Merged #57.\n\n${paragraph(0, 10)}\n\n<details><summary>Details</summary>\n\n${paragraph(10, 6)}\n\n</details>`;
    const result = foldLongReply(reply);
    expect(headOf(result)).toBe("Merged #57.");
    expect(result.match(/<details>/g)).toHaveLength(1);
    expect(result).toContain(`${paragraph(0, 10)}\n\n${paragraph(10, 6)}`);
  });

  it("never cuts inside a code fence", () => {
    const fence = "```sh\nnode a.mjs\n\nnode b.mjs\n```";
    const reply = ["Run these two:", fence, paragraph(0, 12)].join("\n\n");
    expect(headOf(foldLongReply(reply))).toBe(`Run these two:\n\n${fence}`);
  });
});
