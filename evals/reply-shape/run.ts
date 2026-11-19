#!/usr/bin/env node
// An eval script, not server code: it shells out to the mcp-tool-use runner and calls models with
// plain fetch, retrying with jittered sleeps.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalRandom:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { cases, type ReplyCase } from "./cases.ts";
import { gradeReply, shape, type Check } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-opus-5-5" },
    // The checkout whose T3 text builds the request: this one, or an older one for a baseline.
    root: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    concurrency: { type: "string", default: "4" },
    effort: { type: "string" },
    "judge-model": { type: "string", default: "claude-sonnet-5-5" },
    baseline: { type: "string" },
    // The client fold that decides the first screen: a replyFold.ts file, or "none". Defaults to
    // the one in --root, or none when that checkout has no fold.
    fold: { type: "string" },
    // Grade the replies in an earlier results.jsonl again, without sampling the model.
    regrade: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--root <checkout>].");
const outDirectory = values.out;
const model = values.model;
const codex = model.startsWith("gpt-");
const root = NodePath.resolve(values.root ?? NodePath.join(import.meta.dirname, "../.."));
const foldFile =
  values.fold ??
  (NodeFS.existsSync(NodePath.join(root, "packages/shared/src/replyFold.ts"))
    ? NodePath.join(root, "packages/shared/src/replyFold.ts")
    : "none");
const clientFold: (reply: string) => string =
  foldFile === "none"
    ? (reply) => reply
    : (
        (await import(NodeURL.pathToFileURL(NodePath.resolve(foldFile)).href)) as {
          foldLongReply: (reply: string) => string;
        }
      ).foldLongReply;
/** What the user sees before tapping anything: the reply as the client shows it, up to a fold. */
const screenOf = (reply: string) => shape(clientFold(reply)).head;
const wanted = values.case?.flatMap((ids) => ids.split(","));
const selected = cases.filter((entry) => wanted === undefined || wanted.includes(entry.id));
if (selected.length === 0) throw new Error("No case matches --case.");

// The CLIProxyAPI pool T3 sessions already use serves both Claude and GPT models.
const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
if (!baseUrl || !token)
  throw new Error("Set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN to the model pool.");

// Every case grades the reply that ends a turn, so the agent is told the work is over. Without
// this, a fake history invites one more check, and the sample grades a progress note instead.
const WORK_DONE =
  "The work for the user's last message is finished and checked. No more tool calls are needed: your next message is your reply to the user.";

/** The case as an mcp-tool-use case, so that runner builds the real harness request for it. */
const asToolUseCase = (entry: ReplyCase) => ({
  id: entry.id,
  area: "reply-shape",
  kind: entry.kind,
  pattern: entry.reply,
  experience: entry.source,
  privacy: "commit-safe",
  setup: {
    role: "top",
    context: [entry.setup.context, WORK_DONE].filter(Boolean).join("\n"),
    priorTurns: entry.setup.priorTurns,
    ...(entry.setup.mocks === undefined ? {} : { mocks: entry.setup.mocks }),
    world: { repo: "acme/app" },
  },
  prompt: "",
  expect: {},
});

/** Request bodies from `root`'s mcp-tool-use dry run, one per case, in case order. */
const requestBodies = (): Array<Record<string, unknown>> => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-reply-shape-"));
  const file = NodePath.join(directory, "cases.ndjson");
  NodeFS.writeFileSync(
    file,
    selected.map((entry) => JSON.stringify(asToolUseCase(entry))).join("\n"),
  );
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(root, "evals/mcp-tool-use/run.ts"),
      "--dry-run",
      "--model",
      model,
      "--cases",
      file,
      ...(values.effort ? ["--effort", values.effort] : []),
    ],
    { cwd: NodePath.join(root, "evals"), encoding: "utf8", maxBuffer: 1 << 28 },
  );
  NodeFS.rmSync(directory, { recursive: true });
  const lines = result.stdout.split("\n").filter((line) => line.startsWith("{"));
  if (result.status !== 0 || lines.length !== selected.length) {
    throw new Error(
      `Dry run in ${root} failed (${lines.length} bodies):\n${result.stderr.slice(-3000)}`,
    );
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  for (let attempt = 0; ; attempt++) {
    const backoff = () => sleep(Math.min(60_000, 2_000 * 2 ** attempt) * (0.5 + Math.random()));
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "advanced-tool-use-2025-11-20",
        },
        body: JSON.stringify(body),
      });
      text = await response.text();
    } catch (error) {
      // The pool sometimes drops a long-running connection; that is as transient as a 5xx.
      if (attempt < 6) {
        await backoff();
        continue;
      }
      throw error;
    }
    if (response.ok) return JSON.parse(text) as Record<string, unknown>;
    // The pool answers 429 when its accounts are busy, and 5xx when a provider is overloaded.
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await backoff();
      continue;
    }
    throw new Error(
      `Model API ${response.status}: ${text.slice(0, 500).replaceAll(token, "[redacted]")}`,
    );
  }
};

type Block = {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
};

const isQuestionTool = (name: string | undefined) => /AskUserQuestion$/.test(name ?? "");

/** How a question card reads to the user: its questions and options, in order. */
const cardText = (input: unknown) => {
  const questions =
    (input as { questions?: ReadonlyArray<Record<string, unknown>> })?.questions ?? [];
  return questions
    .map((question) =>
      [
        String(question.question ?? ""),
        ...((question.options as ReadonlyArray<Record<string, unknown>> | undefined) ?? []).map(
          (option) => `- ${String(option.label ?? "")}: ${String(option.description ?? "")}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
};

/** The reply the user reads. A question card counts as part of it, after the text before it. */
const sampleClaude = async (body: Record<string, unknown>, entry: ReplyCase) => {
  const ask = (choice: "auto" | "none") =>
    post("/v1/messages", { ...body, tool_choice: { type: choice } });
  const hasText = (blocks: ReadonlyArray<Block>) =>
    blocks.some((block) => block.type === "text" && (block.text ?? "").trim() !== "");
  let response = await ask(entry.questionTool ? "auto" : "none");
  let content = response.content as ReadonlyArray<Block>;
  const card = content.find((block) => block.type === "tool_use" && isQuestionTool(block.name));
  // Another tool call would only delay the reply this case grades, and text beside it is a progress
  // note. With tools off, a model that still wanted one sometimes ends on thinking alone; a fresh
  // sample usually answers.
  const isReply = (blocks: ReadonlyArray<Block>) =>
    hasText(blocks) && !blocks.some((block) => block.type === "tool_use");
  if (!card) {
    for (let retry = 0; !isReply(content) && retry < 3; retry++) {
      response = await ask("none");
      content = response.content as ReadonlyArray<Block>;
    }
  }
  const said = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n\n")
    .trim();
  return {
    reply: card ? `${said}\n\n${cardText(card.input)}`.trim() : said,
    usedCard: Boolean(card),
    stop: `${String(response.stop_reason)}: ${content.map((block) => block.name ?? block.type).join(", ")}`,
  };
};

const sampleCodex = async (body: Record<string, unknown>) => {
  const response = await post("/v1/responses", { ...body, stream: false, tool_choice: "none" });
  const output = response.output as ReadonlyArray<{ type: string; content?: ReadonlyArray<Block> }>;
  // Codex can post commentary before its final message; T3 folds that into the turn's work log,
  // so the last message is the reply the user reads.
  const reply = (output.findLast((item) => item.type === "message")?.content ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return {
    reply,
    usedCard: false,
    stop: `${String(response.status)}: ${output.map((item) => item.type).join(", ")}`,
  };
};

const JUDGE_SYSTEM = [
  "You grade one reply an AI coding agent wrote to a busy user who runs many agent threads at once and often reads on a phone.",
  "On first look the user sees only the first screen you are given; everything else is folded until tapped.",
  "Grade where the needed content sits and whether it is there, not the agent's judgment calls, dates or wording. Answer with one JSON object and nothing else.",
].join("\n");

const lastUserText = (entry: ReplyCase) =>
  [...entry.setup.priorTurns].reverse().find((turn) => turn.role === "user" && turn.text)?.text ??
  "";

const judge = async (entry: ReplyCase, reply: string, screen: string) => {
  const prompt = [
    `The user's last message: ${lastUserText(entry)}`,
    "",
    `What the user needs from this reply: ${entry.rubric}`,
    entry.kind === "control"
      ? 'The user asked for this detail. The first line must give the bottom line, and the full reply must still carry the detail; it may sit behind a fold. For "enoughToAct", judge whether the full reply answers what they asked.'
      : "The user wants the outcome or the ask first, then only what they need to act; the rest may be folded.",
    "",
    `<first_screen>\n${screen}\n</first_screen>`,
    "",
    `<full_reply>\n${reply}\n</full_reply>`,
    "",
    'Return {"leadsWithPoint": boolean (the first line states the outcome or the ask), "enoughToAct": boolean (the first screen alone gives the user what they need: the result, anything they must do or decide or that nothing is needed, and the link or path when there is one), "followUpNeeded": boolean (the user would have to ask a follow-up to act), "notes": "one sentence"}.',
  ].join("\n");
  const response = await post("/v1/messages", {
    model: values["judge-model"],
    max_tokens: 1500,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  const text = (response.content as ReadonlyArray<Block>).map((block) => block.text ?? "").join("");
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json === undefined) throw new Error(`judge gave no JSON: ${text.slice(0, 300)}`);
  const verdict = JSON.parse(json) as {
    leadsWithPoint?: boolean;
    enoughToAct?: boolean;
    followUpNeeded?: boolean;
    notes?: string;
  };
  return {
    pass:
      verdict.leadsWithPoint === true &&
      verdict.enoughToAct === true &&
      verdict.followUpNeeded === false,
    ...verdict,
  };
};

type Row = {
  readonly id: string;
  readonly kind: ReplyCase["kind"];
  readonly reply: ReplyCase["reply"];
  readonly model: string;
  readonly sample: number;
  readonly pass?: boolean;
  readonly mechanical?: boolean;
  readonly judged?: boolean;
  readonly checks?: ReadonlyArray<Check>;
  readonly verdict?: Awaited<ReturnType<typeof judge>>;
  readonly headWords?: number;
  /** Words the reader sees before a fold once T3's client folds a long reply. */
  readonly shownWords?: number;
  readonly words?: number;
  readonly hasDetails?: boolean;
  readonly usedCard?: boolean;
  /** The model's stop reason and the blocks it returned, for reading a failed sample. */
  readonly stop?: string;
  readonly text?: string;
  readonly error?: string;
};

const grade = async (
  entry: ReplyCase,
  identity: Pick<Row, "id" | "kind" | "reply" | "model" | "sample">,
  reply: string,
  extra: Pick<Row, "usedCard" | "stop">,
): Promise<Row> => {
  const screen = screenOf(reply);
  const checks = gradeReply(entry.expect, reply, screen);
  const mechanical = checks.every((check) => check.pass);
  const verdict = await judge(entry, reply, screen);
  const s = shape(reply);
  return {
    ...identity,
    pass: mechanical && verdict.pass,
    mechanical,
    judged: verdict.pass,
    checks,
    verdict,
    headWords: s.headWords,
    shownWords: shape(screen).headWords,
    words: s.words,
    hasDetails: s.hasDetails,
    ...extra,
    text: reply,
  };
};

const runSample = async (
  entry: ReplyCase,
  body: Record<string, unknown>,
  sample: number,
): Promise<Row> => {
  const identity = { id: entry.id, kind: entry.kind, reply: entry.reply, model, sample };
  try {
    const { reply, usedCard, stop } = codex
      ? await sampleCodex(body)
      : await sampleClaude(body, entry);
    if (reply === "") throw new Error(`empty reply (${stop})`);
    return await grade(entry, identity, reply, { usedCard, stop });
  } catch (error) {
    return { ...identity, error: String(error instanceof Error ? error.message : error) };
  }
};

/** Grades a stored reply again: new checks or a different client fold, same model output. */
const regradeRow = async (row: Row): Promise<Row> => {
  const entry = cases.find((candidate) => candidate.id === row.id);
  if (entry === undefined || row.text === undefined) return row;
  const identity = {
    id: row.id,
    kind: row.kind,
    reply: row.reply,
    model: row.model,
    sample: row.sample,
  };
  try {
    return await grade(entry, identity, row.text, {
      ...(row.usedCard === undefined ? {} : { usedCard: row.usedCard }),
      ...(row.stop === undefined ? {} : { stop: row.stop }),
    });
  } catch (error) {
    return { ...identity, error: String(error instanceof Error ? error.message : error) };
  }
};

/** Runs `tasks` with at most `limit` in flight, keeping their order. */
const pool = async <A>(tasks: ReadonlyArray<() => Promise<A>>, limit: number) => {
  const results: Array<A> = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
};

const median = (numbers: ReadonlyArray<number>) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return sorted.length === 0 ? NaN : sorted[Math.floor((sorted.length - 1) / 2)]!;
};
const rate = (rows: ReadonlyArray<Row>, key: "pass" | "mechanical" | "judged") => {
  const graded = rows.filter((row) => row.error === undefined);
  return graded.length === 0 ? NaN : graded.filter((row) => row[key]).length / graded.length;
};
const percent = (value: number) => (Number.isNaN(value) ? "-" : `${Math.round(value * 100)}%`);

/** A case passes when more than half of its graded samples pass. */
const casePasses = (rows: ReadonlyArray<Row>) => {
  const graded = rows.filter((row) => row.error === undefined);
  return graded.length > 0 && graded.filter((row) => row.pass).length > graded.length / 2;
};

const readRows = (file: string) =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

const samples = Number(values.samples);
const tasks = values.regrade
  ? readRows(values.regrade)
      .filter((row) => wanted === undefined || wanted.includes(row.id))
      .map((row) => () => regradeRow(row))
  : (() => {
      const bodies = requestBodies();
      return selected.flatMap((entry, index) =>
        Array.from({ length: samples }, (_, sample) => () => {
          process.stderr.write(`${entry.id} #${sample}\n`);
          return runSample(entry, bodies[index]!, sample);
        }),
      );
    })();
const rows = await pool(tasks, Number(values.concurrency));

const baseline = values.baseline ? readRows(values.baseline) : undefined;

const commit = NodeChildProcess.spawnSync("git", ["describe", "--always", "--dirty"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const lines = [
  "# Reply shape eval",
  "",
  values.regrade
    ? `- Regraded \`${values.regrade}\`, client fold \`${foldFile}\`, judge ${values["judge-model"]}.`
    : `- ${model}, T3 text from \`${root}\` at \`${commit}\`, client fold \`${foldFile}\`, ${samples} samples per case, judge ${values["judge-model"]}.`,
  `- Samples: ${rows.length}, errored ${rows.filter((row) => row.error !== undefined).length}.`,
  "",
  "| Group | Cases passing | Samples passing | Mechanical | Judge | Median head words | First screen words | Median words | Uses details |",
  "|---|---|---|---|---|---|---|---|---|",
];
const groupLine = (name: string, members: ReadonlyArray<Row>) => {
  const byCase = Map.groupBy(members, (row) => row.id);
  const passing = [...byCase.values()].filter(casePasses).length;
  const graded = members.filter((row) => row.error === undefined);
  return `| ${name} | ${passing}/${byCase.size} | ${percent(rate(members, "pass"))} | ${percent(rate(members, "mechanical"))} | ${percent(rate(members, "judged"))} | ${median(graded.map((row) => row.headWords ?? 0))} | ${median(graded.map((row) => row.shownWords ?? 0))} | ${median(graded.map((row) => row.words ?? 0))} | ${graded.filter((row) => row.hasDetails).length}/${graded.length} |`;
};
lines.push(
  groupLine(
    "all bad",
    rows.filter((row) => row.kind === "bad"),
  ),
);
lines.push(
  groupLine(
    "controls",
    rows.filter((row) => row.kind === "control"),
  ),
);
for (const [reply, members] of Map.groupBy(rows, (row) => row.reply))
  lines.push(groupLine(reply, members));
if (baseline) {
  lines.push(
    "",
    "| Baseline | Cases passing | Samples passing | Median head words |",
    "|---|---|---|---|",
  );
  for (const kind of ["bad", "control"] as const) {
    const was = baseline.filter((row) => row.kind === kind);
    const byCase = Map.groupBy(was, (row) => row.id);
    const graded = was.filter((row) => row.error === undefined);
    lines.push(
      `| ${kind} | ${[...byCase.values()].filter(casePasses).length}/${byCase.size} | ${percent(rate(was, "pass"))} | ${median(graded.map((row) => row.headWords ?? 0))} |`,
    );
  }
}
lines.push("", "| Case | Kind | Pass | Head words | Failed checks |", "|---|---|---|---|---|");
for (const [id, members] of Map.groupBy(rows, (row) => row.id)) {
  const failed = new Set(
    members.flatMap((row) => [
      ...(row.checks ?? []).filter((check) => !check.pass).map((check) => check.check),
      ...(row.verdict && !row.verdict.pass ? ["judge"] : []),
      ...(row.error ? ["error"] : []),
    ]),
  );
  lines.push(
    `| ${id} | ${members[0]!.kind} | ${members.filter((row) => row.pass).length}/${members.length} | ${members.map((row) => row.headWords ?? "-").join(", ")} | ${[...failed].join("; ").replaceAll("|", "\\|")} |`,
  );
}
const summary = `${lines.join("\n")}\n`;
NodeFS.mkdirSync(outDirectory, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(outDirectory, "results.jsonl"),
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), summary);
process.stdout.write(summary);
