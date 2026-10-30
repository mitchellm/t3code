export type LedgerFactKind = "commit" | "file" | "tests" | "pr";

export interface LedgerFact {
  readonly kind: LedgerFactKind;
  readonly label: string;
  /** Full value for a tooltip or copy, e.g. the whole path with its line. */
  readonly value: string;
  readonly tone?: "success" | "error";
}

export interface LedgerDigest {
  readonly headline: string;
  readonly facts: ReadonlyArray<LedgerFact>;
  /** More facts existed than the cap. */
  readonly moreFacts: number;
  /** The headline is not the whole text, so a "show full" control is worth offering. */
  readonly truncated: boolean;
}

const MAX_HEADLINE_LENGTH = 180;
const SHORT_SENTENCE_LENGTH = 25;
const MAX_FACTS = 6;

const stripMarkdown = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim();
    if (line.startsWith("```")) return [];
    const plain = line
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(^|[^\w*])\*(?!\s)([^*]*[^\s*])\*(?![\w*])/g, "$1$2")
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return plain === "" ? [] : [plain];
  });

// A sentence ends at whitespace after . ! ? or ;, so dots inside names, versions and numbers survive.
const splitSentences = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line) => line.split(/(?<=[.!?;])\s+/));

const trimTerminator = (text: string) => text.replace(/[.!?;]+$/, "");

const capHeadline = (text: string) => {
  if (text.length <= MAX_HEADLINE_LENGTH) return text;
  const room = text.slice(0, MAX_HEADLINE_LENGTH - 1);
  const atWordEnd = /\s/.test(text.charAt(MAX_HEADLINE_LENGTH - 1));
  const lastSpace = room.lastIndexOf(" ");
  const cut = atWordEnd || lastSpace <= 0 ? room : room.slice(0, lastSpace);
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
};

interface FactCandidate {
  readonly index: number;
  readonly key: string;
  readonly fact: LedgerFact;
}

// Delimiters keep paths and shas intact when they sit in backticks, parentheses or link syntax.
const TOKEN = /[^\s"'<>()[\]{},]+/g;
const COMMIT_TOKEN = /^[0-9a-f]{7,40}$/i;
const FILE_TOKEN =
  /^(?<path>(?:[A-Za-z]:)?(?:[^\\/:\s]*[\\/])*(?<base>[^\\/:\s]*[A-Za-z][^\\/:\s]*\.(?<ext>[A-Za-z0-9]{1,6})))(?::(?<line>\d+)(?::\d+|-\d+)?)?$/;
const PR_URL = /\/pull\/(\d+)(?!\d)/;
const PR_REFERENCE = /(?:^|\bPR\s*|\bpull\s+(?:request\s+)?)#(\d+)\b/gim;
const TESTS_PASSED = /\b(\d+)(?:\s*\/\s*\d+)?\s+(?:tests?\s+)?pass(?:ed|es|ing)?\b/gi;
const TESTS_FAILED = /\b(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?|s)?\b/gi;

const prFact = (number: string, value: string): LedgerFact => ({
  kind: "pr",
  label: `PR #${number}`,
  value,
});

const tokenCandidates = (text: string): ReadonlyArray<FactCandidate> => {
  const candidates: Array<FactCandidate> = [];
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0].replace(/[.;:!?]+$/, "");
    const index = match.index ?? 0;
    if (token.includes("://")) {
      const pull = PR_URL.exec(token);
      if (pull?.[1]) {
        candidates.push({ index, key: `pr:${pull[1]}`, fact: prFact(pull[1], token) });
      }
      continue;
    }
    if (COMMIT_TOKEN.test(token) && /\d/.test(token) && /[a-f]/i.test(token)) {
      candidates.push({
        index,
        key: `commit:${token.toLowerCase()}`,
        fact: { kind: "commit", label: token.slice(0, 7), value: token },
      });
      continue;
    }
    const file = FILE_TOKEN.exec(token)?.groups;
    const hasDirectory = file?.path !== undefined && file.path !== file.base;
    // Version numbers and durations like `1.5s` look like files without a directory or line.
    if (file?.base && file.ext && /[A-Za-z]/.test(file.ext) && (hasDirectory || file.line)) {
      candidates.push({
        index,
        key: `file:${token}`,
        fact: {
          kind: "file",
          label: file.line ? `${file.base}:${file.line}` : file.base,
          value: token,
        },
      });
    }
  }
  return candidates;
};

const referenceCandidates = (text: string): ReadonlyArray<FactCandidate> =>
  Array.from(text.matchAll(PR_REFERENCE), (match) => ({
    index: match.index ?? 0,
    key: `pr:${match[1]}`,
    fact: prFact(match[1] ?? "", `#${match[1]}`),
  }));

// Summaries list test files before tests, so the biggest count is the test total.
const largestCount = (text: string, pattern: RegExp) => {
  let best: { readonly count: number; readonly index: number; readonly snippet: string } | null =
    null;
  for (const match of text.matchAll(pattern)) {
    const count = Number(match[1]);
    if (best === null || count > best.count) {
      best = { count, index: match.index ?? 0, snippet: match[0] };
    }
  }
  return best;
};

const testCandidates = (text: string): ReadonlyArray<FactCandidate> => {
  const candidates: Array<FactCandidate> = [];
  const passed = largestCount(text, TESTS_PASSED);
  if (passed) {
    candidates.push({
      index: passed.index,
      key: "tests:passed",
      fact: {
        kind: "tests",
        label: `${passed.count} passed`,
        value: passed.snippet,
        ...(passed.count > 0 ? { tone: "success" as const } : {}),
      },
    });
  }
  const failed = largestCount(text, TESTS_FAILED);
  if (failed && failed.count > 0) {
    candidates.push({
      index: failed.index,
      key: "tests:failed",
      fact: {
        kind: "tests",
        label: `${failed.count} failed`,
        value: failed.snippet,
        tone: "error",
      },
    });
  }
  return candidates;
};

const extractFacts = (text: string) => {
  // Same length as the input so match indexes stay comparable; markdown emphasis becomes a delimiter.
  const plain = text.replace(/[*`]/g, " ");
  const seen = new Set<string>();
  const facts = [...tokenCandidates(plain), ...referenceCandidates(plain), ...testCandidates(plain)]
    .sort((a, b) => a.index - b.index)
    .filter((candidate) => {
      if (seen.has(candidate.key)) return false;
      seen.add(candidate.key);
      return true;
    })
    .map((candidate) => candidate.fact);
  return { facts: facts.slice(0, MAX_FACTS), moreFacts: Math.max(0, facts.length - MAX_FACTS) };
};

export function digestLedgerText(text: string | null | undefined): LedgerDigest | null {
  if (text === null || text === undefined) return null;
  const sentences = splitSentences(stripMarkdown(text));
  const [first, second] = sentences;
  if (first === undefined) return null;

  const lead =
    first.length < SHORT_SENTENCE_LENGTH && second !== undefined ? `${first} ${second}` : first;
  const headline = capHeadline(trimTerminator(lead));
  return {
    headline,
    ...extractFacts(text),
    truncated: headline !== trimTerminator(sentences.join(" ")),
  };
}
