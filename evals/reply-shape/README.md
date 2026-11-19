# Reply shape

Checks whether a reply that ends an agent's turn puts what the user needs on the first screen: a headline with the outcome or the ask, then the decision, link or caveat they act on, with the rest folded. Each bad case is shaped after a real reply the user had to ask about ("what do I need to do?", "link it", "TLDR"). Controls are replies where the user asked for an explanation, so the detail must still be there.

The request is built by `../mcp-tool-use/run.ts --dry-run` from a checkout, so the model sees T3's real harness prompt for that checkout. Each case is a finished piece of work; the sample is the next message, with tools off (Claude may end on `AskUserQuestion` in cases that allow it).

## Run

```sh
cd evals
pnpm reply-shape --out runs/new
pnpm reply-shape --out runs/old --root ../../<checkout at the old text>
pnpm reply-shape --model gpt-6.1-sol --out runs/new-gpt
pnpm reply-shape --out runs/old-regraded --regrade runs/old/results.jsonl --fold none
```

- Models go through the CLIProxyAPI pool T3 sessions use: set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. Claude ids use `/v1/messages`, `gpt-*` ids `/v1/responses`.
- `--root <checkout>` builds the harness prompt from another checkout, which is how to compare old text against new. That checkout needs `vp i`.
- `--fold <file|none>` is the client fold that decides the first screen. It defaults to `--root`'s `packages/shared/src/replyFold.ts`, or none when that checkout has no fold.
- `--regrade <results.jsonl>` grades stored replies again (new checks, another fold) without sampling the model.
- Flags: `--case <ids>`, `--samples <n>` (default 2), `--concurrency <n>` (default 4; the pool returns 429 past a few), `--effort <level>`, `--judge-model <id>` (default `claude-sonnet-5-5`), `--baseline <results.jsonl>`.
- Cost: a full run is 19 cases x 2 samples, plus one judge call each; about 80 model calls.

## Grading

- The first screen is the reply as the client shows it, up to the first fold.
- Mechanical (`grade.ts`, tested in `run.test.ts`): the first line matches the case's `lead`; `headMust` strings are on the first screen; `bodyMust` facts are still somewhere in the reply; the first screen is at most 50 words. Controls instead need at least `minWords` in the reply, so going short did not drop the explanation.
- Judge: a model reads the rubric, the first screen and the full reply, and answers whether line one states the point, whether the first screen alone lets the user act, and whether a follow-up question would be needed.
- A sample passes when both pass; a case passes when most of its samples do.

## Results

2026-11-19, 2 samples per case, bad cases only unless noted. "Old" is mitchellm/main 3c036d74da (no fold), "v2" is 3ebd73e7e7 (5 lines, 60-word fold), "headline" is the headline text with the headline fold. Old and v2 replies are the stored samples, regraded with the first screen their own client showed.

| Model       | Text     | First screen words | Total words | Line one states the point | Can act from first screen | Follow-up needed | Facts kept | Controls passing |
| ----------- | -------- | ------------------ | ----------- | ------------------------- | ------------------------- | ---------------- | ---------- | ---------------- |
| Opus 5.5    | old      | 122                | 122         | 87%                       | 87%                       | 10%              | 100%       | 8/8              |
| Opus 5.5    | v2       | 77                 | 126         | 100%                      | 73%                       | 10%              | 100%       | 7/8              |
| Opus 5.5    | headline | 39                 | 158         | 100%                      | 43%                       | 13%              | 100%       | 8/8              |
| GPT-6.1 Sol | old      | 39                 | 39          | 86%                       | 71%                       | 25%              | 100%       | 5/8              |
| GPT-6.1 Sol | v2       | 32                 | 36          | 93%                       | 57%                       | 40%              | 100%       | 6/8              |
| GPT-6.1 Sol | headline | 23                 | 35          | 93%                       | 43%                       | 30%              | 100%       | 7/8              |

The headline cuts the first screen to a third on Opus. No fact is dropped, and Opus writes more detail below the fold, not less. The cost is a tap: the decision, link or caveat sits on the first screen less often. A headline alone, with no action lines under it, did worse (Opus: 23 words, 23% can act, 17% follow-up), so the action lines stay.

## Add a case

Add an entry to `cases.ts`: the user's request and the finished work as prior turns, the reply kind, `expect`, and a rubric for the judge. Name the source. Use Acme data only. Run it on the old text first: a bad case must fail there.
