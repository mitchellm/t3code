/**
 * Fork: a long final reply shows its opening and folds the rest, so a reader scanning many threads
 * sees the outcome first and taps for detail. Agents are asked to fold their own detail into
 * `<details>`; this covers replies that don't. Web and mobile both render the fold it writes.
 */

// Replies shorter than this read fine in full.
const FOLD_MIN_WORDS = 150;
// The head stops at the first unit that reaches this many words.
const HEAD_WORDS = 60;
// A fold that hides only a few lines costs a tap for nothing.
const REST_MIN_WORDS = 40;

const countWords = (text: string) => text.split(/\s+/u).filter((word) => /\w/u.test(word)).length;

// Top-level items only: an indented sub-item stays with its parent.
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])\s/u;

/**
 * The places a reply may be cut: between blocks, and between the items of a top-level list. A
 * fenced code block or a table stays whole. Each unit keeps the text that separated it from the
 * one before, so the reply reads the same on either side of the cut.
 */
const unitsOf = (markdown: string): Array<{ separator: string; text: string }> => {
  const units: Array<{ separator: string; text: string }> = [];
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

const isHeading = (unit: string) => /^#{1,6}\s/u.test(unit.trim()) && !unit.trim().includes("\n");

const join = (units: ReadonlyArray<{ separator: string; text: string }>) =>
  units.map((unit, index) => (index === 0 ? unit.text : unit.separator + unit.text)).join("");

/** The reply with everything after its opening lines folded under "More · N words". */
export function foldLongReply(markdown: string): string {
  if (/<details[\s>]/iu.test(markdown) || countWords(markdown) < FOLD_MIN_WORDS) return markdown;
  const units = unitsOf(markdown.replace(/\r\n/gu, "\n").trim());
  let cut = 0;
  let words = 0;
  while (cut < units.length && (cut === 0 || words < HEAD_WORDS)) {
    words += countWords(units[cut]!.text);
    cut += 1;
  }
  // A heading, or a line that introduces a list, belongs with what follows it.
  while (cut > 1 && (isHeading(units[cut - 1]!.text) || /:\s*$/u.test(units[cut - 1]!.text))) {
    cut -= 1;
  }
  const rest = join(units.slice(cut));
  const restWords = countWords(rest);
  if (restWords < REST_MIN_WORDS) return markdown;
  // The blank line after </summary> makes web parse the body as markdown.
  return `${join(units.slice(0, cut))}\n\n<details><summary>More · ${restWords} words</summary>\n\n${rest}\n\n</details>`;
}
