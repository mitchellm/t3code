import { describe, expect, it } from "vite-plus/test";
import { gradeReply, shape, type ReplyExpect } from "./grade.ts";

const PR = "https://github.com/acme/app/pull/42";
const expectMerged = { lead: "merged|failed", headMust: ["pull/42"], bodyMust: ["12 tests"] };
const passes = (reply: string, expectation: ReplyExpect = expectMerged) =>
  gradeReply(expectation, reply).every((check) => check.pass);

describe("shape", () => {
  it("cuts the head at the first <details> and ignores markdown on the first line", () => {
    const s = shape(
      `**Merged.** ${PR}\n\n<details><summary>Detail</summary>\n\nlong text here\n</details>`,
    );
    expect(s.firstLine).toBe(`Merged. ${PR}`);
    expect(s.hasDetails).toBe(true);
    expect(s.head).not.toContain("long text");
  });
});

describe("gradeReply", () => {
  it("passes a short head whose detail is folded", () => {
    const reply = `Merged: ${PR}\nNothing needed from you.\n\n<details><summary>What changed</summary>\n\n12 tests pass.\n</details>`;
    expect(passes(reply)).toBe(true);
  });

  it("fails a reply that narrates before the outcome", () => {
    const reply = `I looked into the reconnect flow first.\n\nMerged: ${PR}. 12 tests pass.`;
    expect(passes(reply)).toBe(false);
  });

  it("fails a long head with no fold, even when line one is right", () => {
    const reply = `Merged: ${PR}\n\n${"The change touches the session layer. ".repeat(20)}12 tests pass.`;
    expect(passes(reply)).toBe(false);
  });

  it("fails when the link only appears inside the fold", () => {
    const reply = `Merged.\n\n<details><summary>Detail</summary>\n\n${PR}, 12 tests pass.\n</details>`;
    expect(passes(reply)).toBe(false);
  });

  it("grades the first screen the client shows, not the raw head", () => {
    const reply = `Merged: ${PR}\n\n${"The change touches the session layer. ".repeat(20)}12 tests pass.`;
    const screen = `Merged: ${PR}`;
    expect(gradeReply(expectMerged, reply, screen).every((check) => check.pass)).toBe(true);
  });

  it("fails a control that answered in one line and dropped the detail it was asked for", () => {
    const control = { lead: "because|cause", bodyMust: ["checkpoint"], minWords: 20 };
    const short = "It stalls because of the WAL gate; the checkpoint waits.";
    const full = `It stalls because of the WAL gate.\n\n<details><summary>Why</summary>\n\nThe checkpoint waits on readers, so every write queues behind the one that holds the WAL open.\n</details>`;
    expect(passes(short, control)).toBe(false);
    expect(passes(full, control)).toBe(true);
  });
});
