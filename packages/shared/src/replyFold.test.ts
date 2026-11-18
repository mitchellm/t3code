import { describe, expect, it } from "vite-plus/test";

import { foldLongReply } from "./replyFold.ts";

const sentence = (n: number) => `Sentence ${n} has exactly seven words here.`;
const paragraph = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

describe("foldLongReply", () => {
  it("leaves short replies and replies that already fold alone", () => {
    expect(foldLongReply("Merged #57. Nothing needed from you.")).toBe(
      "Merged #57. Nothing needed from you.",
    );
    const folded = `Merged.\n\n<details><summary>Details</summary>\n\n${paragraph(0, 40)}\n\n</details>`;
    expect(foldLongReply(folded)).toBe(folded);
  });

  it("keeps the opening blocks and folds the rest under a word count", () => {
    const reply = [paragraph(0, 5), paragraph(5, 5), paragraph(10, 20), paragraph(30, 10)].join(
      "\n\n",
    );
    const result = foldLongReply(reply);
    expect(result.startsWith(`${paragraph(0, 5)}\n\n${paragraph(5, 5)}\n\n<details>`)).toBe(true);
    expect(result).toContain("<summary>More · 210 words</summary>\n\n");
    expect(result).toContain(paragraph(30, 10));
    expect(result.trimEnd().endsWith("</details>")).toBe(true);
  });

  it("never cuts inside a code fence, even one with blank lines", () => {
    const fence = "```sh\nnode a.mjs\n\nnode b.mjs\n```";
    const reply = [paragraph(0, 8), fence, paragraph(8, 30)].join("\n\n");
    const head = foldLongReply(reply).split("<details>")[0]!;
    expect(head).toContain("node b.mjs\n```");
  });

  it("does not fold a heading away from its section's text", () => {
    const reply = [paragraph(0, 8), "## Why it happens now", paragraph(8, 30)].join("\n\n");
    const [head, rest] = foldLongReply(reply).split("<details>");
    expect(head).not.toContain("## Why");
    expect(rest).toContain("## Why it happens now");
  });

  it("cuts a long list between items, keeping sub-items and tables whole", () => {
    const items = Array.from({ length: 14 }, (_, i) => `- ${sentence(5 + i)}\n  - sub of ${i}`);
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const reply = [paragraph(0, 5), items.join("\n"), table].join("\n\n");
    const [head, rest] = foldLongReply(reply).split("<details>");
    expect(head).toBe(`${paragraph(0, 5)}\n\n${items.slice(0, 3).join("\n")}\n\n`);
    expect(rest).toContain(`\n\n${items.slice(3).join("\n")}\n\n${table}\n\n</details>`);
  });

  it("keeps a line that introduces a list with the list", () => {
    const reply = [paragraph(0, 8), "Here are your three options:", paragraph(8, 30)].join("\n\n");
    const [head, rest] = foldLongReply(reply).split("<details>");
    expect(head).not.toContain("options:");
    expect(rest).toContain("Here are your three options:");
  });

  it("leaves a reply alone when little would be folded", () => {
    const reply = [paragraph(0, 20), paragraph(20, 3)].join("\n\n");
    expect(foldLongReply(reply)).toBe(reply);
  });
});
