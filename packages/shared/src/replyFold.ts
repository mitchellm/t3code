/**
 * Fork: a finished reply shows its headline and the short action lines under it (a decision, a
 * link, a caveat), and folds the rest under "More · N words", so a reader scanning many threads
 * reads a line or two per thread and taps for detail. Agents are asked to write exactly that on
 * top; the fold keeps the screen short when they write more. Web and mobile render the fold.
 */

// Replies shorter than this read fine in full.
const FOLD_MIN_WORDS = 60;
// A reply that folds its own detail under a head this short is left as written.
const OWN_HEAD_MAX_WORDS = 60;
// An opening paragraph longer than this is cut after its first sentence.
const LONG_OPENING_WORDS = 60;
// A first sentence shorter than this is too short to stand alone.
const MIN_SENTENCE_WORDS = 12;
// Short lines right under the headline are its action lines: a decision, a link, a caveat.
const ACTION_LINE_MAX_WORDS = 25;
const ACTION_LINES_MAX = 5;
const HEAD_MAX_WORDS = 60;
// A fold that hides only a line or two costs a tap for nothing.
const REST_MIN_WORDS = 15;

const countWords = (text: string) => text.split(/\s+/u).filter((word) => /\w/u.test(word)).length;

// Top-level items only: an indented sub-item stays with its parent.
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])\s/u;
// The reply's own first fold, with its summary, so a long head above it can be refolded.
const OWN_FOLD = /<details[^>]*>\s*(?:<summary[^>]*>[\s\S]*?<\/summary>)?([\s\S]*?)<\/details>/iu;

type Unit = { separator: string; text: string };

/**
 * The places a reply may be cut: between blocks, and between the items of a top-level list. A
 * fenced code block or a table stays whole. Each unit keeps the text that separated it from the
 * one before, so the reply reads the same on either side of the cut.
 */
const unitsOf = (markdown: string): Array<Unit> => {
  const units: Array<Unit> = [];
  let current: Array<string> = [];
  let separator = "";
  let blank = false;
  let fence: string | null = null;
  const flush = (next: string) => {
    if (current.length > 0) units.push({ separator, text: current.join("\n") });
    current = [];
    separator = next;
  };
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence !== null) {
      current.push(line);
      if (marker !== undefined && marker.startsWith(fence)) fence = null;
      continue;
    }
    if (line.trim() === "") {
      blank = current.length > 0 || blank;
      continue;
    }
    const startsItem = LIST_ITEM.test(line);
    const inTable = current.length > 0 && current.at(-1)!.trimStart().startsWith("|");
    const continuesTable = inTable && line.trimStart().startsWith("|");
    if (blank) flush("\n\n");
    else if (startsItem && !continuesTable) flush("\n");
    blank = false;
    if (marker !== undefined) fence = marker[0]!.repeat(marker.length);
    current.push(line);
  }
  flush("");
  return units;
};

const isHeading = (text: string) => /^#{1,6}\s/u.test(text.trim()) && !text.trim().includes("\n");
// A heading, or a line that introduces what follows ("Run these two:"), needs the next unit.
const leadsIn = (text: string) => isHeading(text) || /:\s*$/u.test(text);
const isParagraph = (text: string) =>
  !LIST_ITEM.test(text) && !/^\s*(`{3,}|~{3,}|\||<|#)/u.test(text);

const join = (units: ReadonlyArray<Unit>) =>
  units.map((unit, index) => (index === 0 ? unit.text : unit.separator + unit.text)).join("");

/** Splits `text` after its first sentence of at least `MIN_SENTENCE_WORDS` words, if it has one. */
const firstSentence = (text: string): [string, string] | undefined => {
  for (const end of text.matchAll(/[.!?](?=\s+["'(*_`[]?[A-Z0-9])/gu)) {
    const head = text.slice(0, end.index + 1);
    if (countWords(head) >= MIN_SENTENCE_WORDS) return [head, text.slice(end.index + 1).trim()];
  }
  return undefined;
};

/** The reply with everything after its headline folded under "More · N words". */
export function foldLongReply(markdown: string): string {
  let text = markdown.replace(/\r\n/gu, "\n").trim();
  if (countWords(text) < FOLD_MIN_WORDS) return markdown;
  const ownFold = text.search(/<details[\s>]/iu);
  if (ownFold !== -1) {
    if (countWords(text.slice(0, ownFold)) <= OWN_HEAD_MAX_WORDS) return markdown;
    // One fold, never two: the reply's own fold joins the rest of its long head.
    text = text.replace(OWN_FOLD, (_, body: string) => `\n\n${body.trim()}\n\n`).trim();
  }
  const units = unitsOf(text);
  let cut = 1;
  while (cut < units.length && leadsIn(units[cut - 1]!.text)) cut += 1;
  const opening = units[cut - 1]!;
  if (countWords(join(units.slice(0, cut))) > LONG_OPENING_WORDS && isParagraph(opening.text)) {
    const split = firstSentence(opening.text);
    if (split !== undefined) {
      units.splice(
        cut - 1,
        1,
        { ...opening, text: split[0] },
        { separator: "\n\n", text: split[1] },
      );
    }
  }
  let headWords = countWords(join(units.slice(0, cut)));
  for (let kept = 0; cut < units.length && kept < ACTION_LINES_MAX; kept += 1) {
    const next = units[cut]!.text;
    const words = countWords(next);
    const actionLine =
      words <= ACTION_LINE_MAX_WORDS &&
      !next.includes("\n") &&
      !/^\s*(`{3,}|~{3,}|\||<|#)/u.test(next);
    if (!actionLine || headWords + words > HEAD_MAX_WORDS) break;
    headWords += words;
    cut += 1;
  }
  const rest = join(units.slice(cut));
  const restWords = countWords(rest);
  if (restWords < REST_MIN_WORDS) return markdown;
  // The blank line after </summary> makes web parse the body as markdown.
  return `${join(units.slice(0, cut))}\n\n<details><summary>More · ${restWords} words</summary>\n\n${rest}\n\n</details>`;
}
