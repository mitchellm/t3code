/** What a case checks in the reply. Regexes are case-insensitive. */
export type ReplyExpect = {
  /** The first line must match: the outcome ("merged", "failed") or the ask. */
  readonly lead: string;
  /** Each must appear in the head: a PR URL, a play link, a file path. */
  readonly headMust?: ReadonlyArray<string>;
  /** Each must appear somewhere in the reply, so going short dropped nothing the user needs. */
  readonly bodyMust?: ReadonlyArray<string>;
  /** None may appear in the head, such as a narration opener. */
  readonly headMustNot?: ReadonlyArray<string>;
  /** Controls: the user asked for the detail, so `bodyMust` must be visible, not folded away. */
  readonly detailVisible?: boolean;
  readonly maxHeadWords?: number;
};

/**
 * The cap on the head, what shows before any `<details>`. The harness asks for "about 70 words";
 * 80 allows the "about". Reading research puts the point where people stop at about 100.
 */
export const HEAD_WORDS = 80;

export type Shape = {
  /** Everything before the first `<details>`, or the whole reply when it has none. */
  readonly head: string;
  readonly headWords: number;
  readonly words: number;
  readonly firstLine: string;
  readonly hasDetails: boolean;
};

const wordCount = (text: string) => text.split(/\s+/).filter((word) => /\w/.test(word)).length;

// Markdown decoration a renderer hides, so a bold "**Merged.**" still reads as "Merged.".
const plainLine = (line: string) =>
  line
    .replace(/^\s*(#+|[-*+]|\d+\.|>)\s+/, "")
    .replace(/[*_`]/g, "")
    .trim();

export const shape = (reply: string): Shape => {
  const text = reply.replace(/\r\n/g, "\n").trim();
  const cut = text.search(/<details[\s>]/i);
  const head = (cut === -1 ? text : text.slice(0, cut)).trim();
  const firstLine = plainLine(text.split("\n").find((line) => plainLine(line) !== "") ?? "");
  return {
    head,
    headWords: wordCount(head),
    words: wordCount(text.replace(/<\/?(details|summary)[^>]*>/gi, " ")),
    firstLine,
    hasDetails: cut !== -1,
  };
};

export type Check = { readonly check: string; readonly pass: boolean; readonly detail?: string };

const matches = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

/** The mechanical checks. A bad case also needs the judge's verdict to pass. */
export const gradeReply = (expect: ReplyExpect, reply: string): ReadonlyArray<Check> => {
  const s = shape(reply);
  const visible = expect.detailVisible ? s.head : reply;
  const checks: Array<Check> = [
    { check: "lead", pass: matches(expect.lead, s.firstLine), detail: s.firstLine.slice(0, 160) },
    ...(expect.headMust ?? []).map((pattern) => ({
      check: `headMust ${pattern}`,
      pass: matches(pattern, s.head),
    })),
    ...(expect.headMustNot ?? []).map((pattern) => ({
      check: `headMustNot ${pattern}`,
      pass: !matches(pattern, s.head),
    })),
    ...(expect.bodyMust ?? []).map((pattern) => ({
      check: `bodyMust ${pattern}`,
      pass: matches(pattern, visible),
    })),
  ];
  if (!expect.detailVisible) {
    const cap = expect.maxHeadWords ?? HEAD_WORDS;
    checks.push({
      check: `head <= ${cap} words`,
      pass: s.headWords <= cap,
      detail: `${s.headWords}`,
    });
  }
  return checks;
};
