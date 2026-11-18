# Reply shape

Checks whether an agent's reply, at the end of a turn, puts what the user needs first: the outcome or the ask in line one, a short head with the link or picture they act on, and the rest folded into `<details>`. Each bad case is shaped after a real reply the user had to ask about ("what do I need to do?", "link it", "TLDR"). Controls are replies where the user asked for an explanation, so the long answer is right and must stay in the open.

The request is built by `../mcp-tool-use/run.ts --dry-run` from a checkout, so the model sees T3's real harness prompt for that checkout. Each case is a finished piece of work; the sample is the next message, with tools off (Claude may end on `AskUserQuestion` in cases that allow it).

## Run

```sh
cd evals
pnpm reply-shape --out runs/new
pnpm reply-shape --out runs/old --root ../../<checkout at the old text>
pnpm reply-shape --model gpt-6.1-sol --out runs/new-gpt
```

- Models go through the CLIProxyAPI pool T3 sessions use: set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. Claude ids use `/v1/messages`, `gpt-*` ids `/v1/responses`.
- `--root <checkout>` builds the harness prompt from another checkout, which is how to compare old text against new. That checkout needs `vp i`.
- Flags: `--case <ids>`, `--samples <n>` (default 2), `--concurrency <n>` (default 4; the pool returns 429 past a few), `--effort <level>`, `--judge-model <id>` (default `claude-sonnet-5-5`), `--baseline <results.jsonl>`.
- Cost: a full run is 19 cases x 2 samples, plus one judge call each; about 80 model calls.

## Grading

- Mechanical (`grade.ts`, tested in `run.test.ts`): the first line matches the case's `lead`; `headMust` strings sit above any fold; `bodyMust` facts are still somewhere in the reply; the head is at most 80 words (60 where a case says so). Controls instead need their `bodyMust` facts above any fold.
- Judge: a model reads only the reply and the case's rubric and answers whether line one states the point, whether the first screen alone lets the user act, and whether a follow-up would be needed.
- A sample passes when both pass; a case passes when most of its samples do.
- `shownWords` is what the reader sees once T3's client folds a long reply (`@t3tools/shared/replyFold`), so a run also shows the effect of the fold.

## Results

One run, 2 samples per case, 2026-11-18. Old text is mitchellm/main 3c036d74da ("Asking the user"); new text is "Replying to the user". Head words are what shows before any fold; "with fold" adds T3's client fold.

| Model       | Text | Bad cases passing | Bad samples passing | Judge | Median head words | With fold | Uses `<details>` | Controls passing |
| ----------- | ---- | ----------------- | ------------------- | ----- | ----------------- | --------- | ---------------- | ---------------- |
| Opus 5.5    | old  | 0/15              | 3%                  | 80%   | 122               | 96        | 0/30             | 4/4              |
| Opus 5.5    | new  | 4/15              | 37%                 | 80%   | 82                | 77        | 18/30            | 3/4              |
| GPT-6.1 Sol | old  | 5/15              | 39%                 | 64%   | 39                | 39        | 0/28             | 2/4              |
| GPT-6.1 Sol | new  | 6/15              | 43%                 | 60%   | 32                | 32        | 5/30             | 3/4              |

Opus moves its detail into a fold (total words stay about the same) and opens half its asks with `Needs you:`. GPT was already short; its failures are omissions (a link or picture the user needed), which the new text does not fix, and it never writes `Needs you:`.

## Add a case

Add an entry to `cases.ts`: the user's request and the finished work as prior turns, the reply kind, `expect`, and a rubric for the judge. Name the source. Use Acme data only. Run it on the old text first: a bad case must fail there.
