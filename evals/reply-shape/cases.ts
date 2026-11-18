import type { ReplyExpect } from "./grade.ts";

/**
 * One case: a fake thread whose work is done, so the agent's next message is the reply the user
 * reads. `setup`, `prompt` and `kind` follow `McpToolUseCase` in ../mcp-tool-use/run.ts, whose
 * runner builds the real harness request. Every case is authored Acme data shaped after a real
 * reply the user had to ask about (`source`); none carries the original text.
 */
export type ReplyCase = {
  readonly id: string;
  readonly kind: "bad" | "control";
  /** What kind of reply this is: a report, a question, a scheduled task's result, a hand-back. */
  readonly reply: "report" | "question" | "scheduled" | "handback";
  readonly source: string;
  /** What the user said next, which the reply should have answered up front. */
  readonly followUp: string;
  readonly setup: {
    readonly context?: string;
    readonly priorTurns: ReadonlyArray<Turn>;
    readonly mocks?: Readonly<Record<string, unknown>>;
  };
  /** The question tool is a fair way to ask here, so the sample may end on it. */
  readonly questionTool?: boolean;
  readonly expect: ReplyExpect;
  /** What the first screen must tell the user, for the judge. */
  readonly rubric: string;
};

type Call = { readonly tool: string; readonly input: unknown; readonly result: unknown };
type Turn = {
  readonly role: "user" | "assistant";
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<Call>;
};

const user = (text: string): Turn => ({ role: "user", text });
const bash = (command: string, result: string): Turn => ({
  role: "assistant",
  toolCalls: [{ tool: "Bash", input: { command, description: command.slice(0, 60) }, result }],
});
const tool = (name: string, input: unknown, result: unknown): Turn => ({
  role: "assistant",
  toolCalls: [{ tool: name, input, result }],
});

const ASK = "needs you|decide|approve|your call|go ahead|\\?";

export const cases: ReadonlyArray<ReplyCase> = [
  {
    id: "triage-decision-at-the-end",
    kind: "bad",
    reply: "question",
    source: "worst15 #1: 995-word triage, the decision at word 991",
    followUp: "explain the huge fix simple concise",
    setup: {
      priorTurns: [
        user(
          "Players say their event pets hit much weaker since yesterday's update. Triage first, it may be design and not a bug. Propose fixes for me to review before anything ships.",
        ),
        bash(
          'gh pr list --repo acme/app --state merged --search "event pet damage" --limit 5',
          "#2694  Lower the event pet damage multiplier to 0.6   merged 2026-11-07\n#2870  Cap event pet damage above zone 279              merged 2026-11-07",
        ),
        bash(
          "sed -n 360,382p src/pets/PetPlayer.lua",
          "366  -- Large pets (Huge, Titanic) take the damage of the strongest pet on the team\n367  local strongest = team:strongestPet()\n372  damage = strongest.damage * LARGE_PET_SCALE\n380  -- above zone 279 the strongest pet is usually an event pet, which #2870 capped",
        ),
        bash(
          "cd /tmp/fix-large-pets && node scripts/probe-damage.mjs --zone 279",
          "copy of main with the fix applied (large pets use their own base damage)\nlarge pet damage at zone 279: before 1.2M, after 4.8M\nprobe 47/47 pass\nrepo untouched: no branch, no PR",
        ),
      ],
    },
    expect: {
      lead: `by design|intended|nerf|real bug|${ASK}`,
      headMust: ["large|huge|titanic", "ship|approve|decide|needs you|go ahead"],
      bodyMust: ["2694|2870"],
    },
    rubric:
      "Most reports are the intended nerf (#2694, #2870). One real bug: large pets copy a capped event pet's damage above zone 279. The user must decide whether to ship the tested fix, with a recommendation. Nothing is in the repo yet.",
  },
  {
    id: "status-review-decisions-buried",
    kind: "bad",
    reply: "question",
    source: "worst15 #2: 1,102-word status review, three decisions in the last section",
    followUp: "what do you mean the check is waiting on boxes that are offline?",
    setup: {
      priorTurns: [
        user(
          "Where do we stand on the update? Review the work that's done and what's left. I'm overwhelmed, keep it straight.",
        ),
        bash(
          "gh pr list --repo acme/app --label update-102 --json number,title,mergeStateStatus",
          "7 PRs Ready to merge, all blocked by required check build-places (pending 6 h, its runner queue is empty)\n#3159 release PR, draft\n#3179 balance freeze candidate",
        ),
        bash(
          "cat notes/art-status.md",
          "Real pet models and art: not delivered, no date from the art team.\nPlaceholder pets keep the production place shut.\nLaunch is Saturday. Art must land by Friday 18:00 UTC to make it.",
        ),
        bash(
          "cat notes/launch-checklist.md",
          "User's jobs: Wednesday, timed fresh-save run on test slot play-10. Saturday, merge #3159, publish, approve the deploy.\nOpen decisions for the user: (1) admin-merge the 7 Ready PRs past the stuck check, (2) slip the launch a week if art misses Friday, (3) freeze balance at #3179.",
        ),
      ],
    },
    expect: {
      lead: `on track|code|art|launch|late|${ASK}`,
      headMust: ["merge|7", "friday|fri"],
    },
    rubric:
      "Code is mostly done; the art is late with no date, and without it by Friday 18:00 UTC there is no Saturday launch. Decisions: admin-merge the 7 Ready PRs past the stuck check, slip a week if art misses Friday, freeze balance at #3179. The user's own jobs this week.",
  },
  {
    id: "scheduled-tick-opens-with-a-table",
    kind: "bad",
    reply: "scheduled",
    source: "worst15 #3 and #4: hourly monitor ticks that open with a table",
    followUp:
      "dont leave this massive dissertation each time. just table + 1/2 sentences super simple",
    setup: {
      context:
        "This turn was started by a scheduled task. The user reads its result later, among many threads.",
      priorTurns: [
        user(
          "Shard rate tick (hourly). Read-only: never change a flag. Report shard income against the target and propose a flag change if the gap is over 10%.",
        ),
        bash(
          "node scripts/shard-rate.mjs --window 1h",
          "window 15:00-16:00Z  income 333,919/hr  target 380,000/hr  r=0.78\nsource       now/hr    target/hr\ngames        120,402   210,000\nbreakables   213,517   170,000\nnet games vs breakables: -46.7k/hr (last tick -44.9k)\nsignal: REBALANCE (unchanged)\nproposal: BreakableShardChance 0.00075 -> 0.001 (+15% income, rare-pet target stays in window)",
        ),
      ],
    },
    expect: {
      lead: "rebalance|short|below|under|gap|over-cut|46|334|333",
      headMust: [
        "0\\.001",
        "your call|needs you|approve|untouched|changed nothing|read-only|no flag",
      ],
    },
    rubric:
      "Signal REBALANCE, unchanged: games are 46.7k/hr short against breakables (income 334k/hr). The user's call: raise BreakableShardChance 0.00075 to 0.001. No flag was changed.",
  },
  {
    id: "approval-card-after-narration",
    kind: "bad",
    reply: "question",
    source: "worst15 #5: question card after six lines of debugging narration, no PR link",
    followUp: "Is this done? Can you show me the final before and afters?",
    questionTool: true,
    setup: {
      priorTurns: [
        user("Finish the merchant restyle in #3303 and get it merged."),
        { role: "assistant", text: "Do you approve the merchant UI in #3303 as pictured?" },
        user("Yes"),
        bash(
          "node scripts/ui-approval.mjs status 3303",
          "PR #3303: UI approval NOT recorded. The approval log has no entry from this session: the logging hook did not fire.",
        ),
        bash(
          "gh pr view 3303 --repo acme/app --json url,body",
          '{"url":"https://github.com/acme/app/pull/3303","body":"Merchant restyle.\\n\\n| Before | After |\\n|---|---|\\n| ![before](https://github.com/acme/app/assets/merchant-before.png) | ![after](https://github.com/acme/app/assets/merchant-after.png) |"}',
        ),
      ],
    },
    expect: {
      lead: `approv|record|log|${ASK}`,
      headMust: ["pull/3303"],
    },
    rubric:
      "#3303 is blocked only because the user's Yes never reached the approval log. Ask: may the agent write the Yes into the log by hand so it can merge? Link the PR (its before and after pictures are there).",
  },
  {
    id: "handover-offers-as-asks",
    kind: "bad",
    reply: "report",
    source: "worst15 #6: a finished handover that listed five 'Your calls', most of them offers",
    followUp: "I think this looks good. Why do you need me?",
    setup: {
      priorTurns: [
        user(
          'This thread replaces "Chat harness" which was started in the wrong project by mistake. Review what it did, summarize it, and carry on to the end of its brief.',
        ),
        tool(
          "t3_thread_read",
          { threadId: "thread-chat-harness", view: "messages", limit: 20 },
          {
            title: "Chat harness",
            summary:
              "Brief: build the chat harness and open PR #2047. Nice to have: publish the report as a page. Done: harness built, #2047 opened.",
          },
        ),
        bash(
          "gh pr checks 2047 --repo acme/app",
          "lint     pass\ntest     pass\nreview   required: waiting on @adam\nhttps://github.com/acme/app/pull/2047",
        ),
        bash(
          "node scripts/publish-report.mjs reports/chat-harness.html",
          "error: this session's login cannot publish pages. Run /login to publish. The report is saved at /home/user/app/reports/chat-harness.html",
        ),
      ],
    },
    expect: {
      lead: "done|finished|complete|handover|green|2047",
      headMust: ["pull/2047|#2047", "nothing|no action|optional|not needed|don't need"],
      headMustNot: ["your calls"],
    },
    rubric:
      "Handover done; #2047 is green and waits on Adam's review. Nothing is needed from the user; publishing the report as a page is optional (needs /login). Others' jobs and offers are not presented as the user's decisions.",
  },
  {
    id: "audit-decisions-after-the-tables",
    kind: "bad",
    reply: "question",
    source: "worst15 #7: leaderboard audit, three decisions at word 400",
    followUp: "okay so what have we done? provide me a list of our options and let's execute",
    setup: {
      priorTurns: [
        user(
          "Audit the leaderboard for bot and alt accounts. Give me the decision table with evidence. Change nothing until I pick.",
        ),
        bash(
          "node scripts/leaderboard-audit.mjs --season current",
          "top 3: clean\nband A (ranks 4-200): 34 high-confidence suspects\nband B (ranks 201-2000): 203 suspects\nalready banned: 456\nclusters: farm F1 = 106 accounts on one IP range; operator alts = 95; ring R1 = 5 accounts trading in a loop\nwindow: delists only Thu 17:00-17:20 UTC; bans any time before Thu 17:00 UTC\nsafety check before a wave: re-run this audit Thursday morning",
        ),
      ],
    },
    expect: {
      lead: `audit|clean|suspect|bot|nothing (banned|changed)|${ASK}`,
      headMust: ["106", "decide|needs you|pick|approve|B1|ban"],
    },
    rubric:
      "Audit done, nothing changed: top 3 clean, 237 suspects below. Decisions: ban the 106-account farm before Thu 17:00 UTC; delist 95 operator alts and the 5-account ring Thu 17:00-17:20 UTC. A recommendation.",
  },
  {
    id: "new-thread-link-and-next-step-late",
    kind: "bad",
    reply: "report",
    source: "worst15 #8: started a thread, the user's next step in the last sentence",
    followUp: "Okay so what do I need to answer to bring this along?",
    setup: {
      priorTurns: [
        user("Make a fixer thread under this one to dump issues to resolve."),
        tool(
          "t3_thread_launch",
          { title: "Update fixer", message: "Fix the issues the user pastes here." },
          {
            threadId: "thread-fixer",
            link: "[Update fixer](t3-thread://v2/env-local/thread-fixer)",
          },
        ),
        bash(
          "cat notes/playtest.md",
          "Open playtest notes (5): shop sign typo, neon too bright, merchant overlaps the path, keep rule unclear, first pumpkin spawns late.",
        ),
      ],
    },
    expect: {
      lead: "fixer|thread|started|created|up",
      headMust: ["t3-thread://", "pick|choose|which|tell it|paste|needs you"],
    },
    rubric:
      "The fixer thread is up (linked). The user's next step: paste issues there, starting by picking which of the 5 open playtest notes it takes.",
  },
  {
    id: "shipped-without-a-link",
    kind: "bad",
    reply: "report",
    source: "worst15 #9: 676 words, the live page never linked",
    followUp: "link it",
    setup: {
      priorTurns: [
        user(
          "On the admin tools site, add a Community Sentiment page that reads the community-signals API and shows how each topic's sentiment trends over time. Ship it to production when it works.",
        ),
        bash(
          "git log --oneline -2 && npm test -- sentiment",
          "8d1e2f0 feat(admin): community sentiment page with topic trends\n5c4b3a2 feat(admin): community-signals API client\nsentiment: 9 passed",
        ),
        bash(
          "npm run deploy -- --prod",
          "built admin-tools in 41s\ndeployed to production: https://admin.acme.dev/tools/community-sentiment",
        ),
        bash(
          "curl -s -o /dev/null -w '%{http_code}' https://admin.acme.dev/tools/community-sentiment",
          "401 (the page needs a dashboard login this session does not have)",
        ),
        bash(
          "npm run logs -- --prod --grep sentiment",
          "sentiment: loaded 19,191 messages from the last 30 days, 6 topics",
        ),
      ],
    },
    expect: {
      lead: "live|deployed|shipped|up|sentiment",
      headMust: ["https://admin\\.acme\\.dev/tools/community-sentiment"],
    },
    rubric:
      "The page is live, with a clickable link. It loaded 19,191 messages over 30 days. The user should open it while logged in, since the agent could not.",
  },
  {
    id: "approval-without-the-picture",
    kind: "bad",
    reply: "question",
    source: "worst15 #10: asked to approve a UI the reply never showed",
    followUp: "Can you show me the UI here? I can't see it. What do I need to approve?",
    setup: {
      priorTurns: [
        user(
          "The lock billboard is fine, that's a separate thing. All I adjusted is the auto-buy settings, the keep settings and the shop itself.",
        ),
        bash(
          "node scripts/shoot-ui.mjs sign loot-panel lock",
          "saved /home/user/app/.shots/sign.png\nsaved /home/user/app/.shots/loot-panel.png\nsaved /home/user/app/.shots/lock.png",
        ),
        bash(
          "gh pr view 3384 --repo acme/app --json url,mergeStateStatus",
          '{"url":"https://github.com/acme/app/pull/3384","mergeStateStatus":"BLOCKED: UI approval not recorded"}',
        ),
      ],
    },
    expect: {
      lead: `approv|3384|${ASK}`,
      headMust: ["!\\[[^\\]]*\\]\\([^)]*\\.png\\)", "pull/3384"],
    },
    rubric:
      "Ask the user to approve the #3384 UI (sign, loot panel, lock) as pictured, with the pictures shown and the PR linked. On yes the agent marks it Ready.",
  },
  {
    id: "play-link-buried",
    kind: "bad",
    reply: "report",
    source: "worst15 #11: the play link 90 words in, as a page that does not open the game",
    followUp: "Give me just a link that opens it straight in Roblox.",
    setup: {
      priorTurns: [
        user("How do I start playtesting it?"),
        bash(
          "node tools/place.mjs list",
          "play-10      https://www.roblox.com/games/96833360282732   build 16 h behind main\ndev-world-1  https://www.roblox.com/games/18901165922      event content is dark here, not visible",
        ),
        bash(
          "cat docs/playtest-commands.md",
          "Type /ppt in chat to enter the event. To move main's build to play-10: node tools/place.mjs unpark play-10 && node tools/place.mjs publish play-10 (slot owner: Adam).",
        ),
      ],
    },
    expect: {
      lead: "play|link|playtest|test",
      headMust: ["roblox\\.com/games/96833360282732", "/ppt"],
    },
    rubric:
      "Play now on play-10 (clickable link), then type /ppt. Its build is 16 hours behind main; to update it, ask Adam or run the two commands. Dev world 1 won't show the event.",
  },
  {
    id: "progress-ping-gets-an-essay",
    kind: "bad",
    reply: "report",
    source: "worst15 #12: 'progress?' answered with 732 words and two tables",
    followUp:
      "I just want you to tell me the data and I'll deal with making changes in other chats. Keep it simple.",
    setup: {
      priorTurns: [
        user(
          "Watch the mint rates for the forge and the classic pets and tell me where they stand.",
        ),
        bash(
          "node scripts/mint-monitor.mjs",
          "forge large pets: 9,010/hr (down 9% for the 2nd hour), limit 300/hr\nguard elephant: 299,816 existing, cap 250,000\nclassic four-pet total: 164/hr, expected 227/hr (72%), falling\nnext report ~00:08Z",
        ),
        user("progress?"),
      ],
    },
    expect: {
      lead: "9,?010|/hr|mint|forge",
      headMust: ["49,?816|299,?816|over (its |the )?cap", "164"],
      maxHeadWords: 60,
    },
    rubric:
      "Just the data: forge 9,010/hr, 30x the 300/hr limit, down 9% for a second hour; guard elephant 49,816 over its cap; classic 164/hr, 72% of expected and falling.",
  },
  {
    id: "scheduled-red-check-explained-last",
    kind: "bad",
    reply: "scheduled",
    source: "worst15 #13: daily port report, the red-check explanation in the last paragraph",
    followUp: "Why is it red on github? Do we need to turn those off? I'm so confused",
    setup: {
      context:
        "This turn was started by a scheduled task. The user reads its result later, among many threads.",
      priorTurns: [
        user("Mac daily port. Run the parity check, act on its verdict, and post the result."),
        bash(
          "node tools/parity.mjs daily",
          "PORTED 1: https://github.com/acme/app/pull/2203 merged\ncommit f666030 Mac-verified\nsmoke 21/21 steps clean, all panes drew",
        ),
        bash(
          "gh run list --repo acme/app --limit 3",
          "check  failed  GitHub could not start the job: the account's Actions billing has failed payments. Not a required check.",
        ),
      ],
    },
    expect: {
      lead: "caught up|verified|ported|2203|mac",
      headMust: ["2203", "billing|payment"],
    },
    rubric:
      "Mac is caught up: f666030 verified after one port (#2203). The red GitHub check is not a failure: GitHub won't start jobs until the Actions billing is fixed by the repo owner.",
  },
  {
    id: "fix-report-never-says-what-changed",
    kind: "bad",
    reply: "report",
    source: "worst15 #14: 76 words about a pixel check, never what was fixed or that it merged",
    followUp: "I don't know what you changed. It just crunched it into main.",
    setup: {
      priorTurns: [
        user(
          "Pets don't auto-attack the giant pumpkin when you walk up to it, and tapping it doesn't pulse like our normal breakables. Fix both and land it on main.",
        ),
        bash(
          "sed -i 's/autoTarget = false/autoTarget = true/; s/-- no tap feedback/Breakable.pulseOnTap(self)/' src/breakables/GiantPumpkin.lua && git diff --stat",
          " src/breakables/GiantPumpkin.lua | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)",
        ),
        bash("npm test -- breakables", "breakables: 18 passed"),
        bash(
          "git commit -am 'fix: pets auto-attack the giant pumpkin and it pulses on tap' && git push origin main",
          "[main 4f3a9c1] fix: pets auto-attack the giant pumpkin and it pulses on tap\nTo github.com:acme/app.git  1a2b3c4..4f3a9c1  main -> main",
        ),
        bash(
          "node scripts/hud-diff.mjs",
          "HUD pixel diff: 0 px differ (the pulse is in the 3D world, not the HUD)",
        ),
      ],
    },
    expect: {
      lead: "fixed|auto-attack|both|pulse",
      headMust: ["4f3a9c1|main"],
      bodyMust: ["attack|auto-?target", "pulse"],
    },
    rubric:
      "Both fixed: pets auto-attack the giant pumpkin, and it pulses on tap like other breakables. On main as 4f3a9c1. Check with one tap in game (the HUD check can't show the pulse).",
  },
  {
    id: "run-me-through-todos-in-a-table",
    kind: "bad",
    reply: "report",
    source: "worst15 #15: a day's roll-up with the user's to-dos scattered in a table column",
    followUp: "Give me a really simple bullet list of what we can get merged into main.",
    setup: {
      priorTurns: [
        user("We did a bunch of update stuff across threads today. Run me through it all."),
        tool(
          "t3_thread_list",
          { allProjects: true, limit: 10 },
          {
            threads: [
              {
                title: "Games fixes",
                status: "done",
                note: "14 fixes merged to main, not published",
              },
              {
                title: "Damage nerf",
                status: "done",
                note: "draft #2694 waits on the user's OK (check with Adam)",
              },
              {
                title: "Adaptive worlds",
                status: "done",
                note: "draft #2695 waits on a yes to one week of shadow scoring",
              },
              { title: "Board audit", status: "done", note: "audit due before Thu 17:20 UTC" },
              { title: "Art handoff", status: "waiting", note: "user to DM Adam about art dates" },
              { title: "Release notes", status: "done", note: "notes drafted in docs/release.md" },
            ],
          },
        ),
      ],
    },
    expect: {
      lead: "today|merged|14|threads|fix",
      headMust: ["publish", "2694"],
    },
    rubric:
      "Today: 14 fixes merged but not live; two drafts wait on the user. The user's list: publish main, OK #2694 (after Adam), yes to shadow scoring for #2695, DM Adam, the audit before Thursday.",
  },
  {
    id: "delegate-handback-essay",
    kind: "bad",
    reply: "handback",
    source:
      "measure: delegate hand-backs run a median 508 words; the parent and the user read them",
    followUp: "(the parent agent relays it; the user reads it in the parent's delegate row)",
    setup: {
      context:
        "You are a delegated child task. Your final message goes to the parent agent, and the user sees it in the parent thread.",
      priorTurns: [
        user("Fix the flaky reconnect test in src/session.test.ts and open a PR."),
        bash(
          "sed -n 40,70p src/session.test.ts",
          "52  socket.close()\n53  await reconnect()   // races the close event about 1 run in 10",
        ),
        bash(
          "git switch -c fix/session-reconnect && sed -i \"53i\\  await once(socket, 'close')\" src/session.test.ts && git commit -qam 'fix: wait for close before reconnecting in the session test' && git push -u origin fix/session-reconnect",
          "Switched to a new branch 'fix/session-reconnect'\nbranch 'fix/session-reconnect' set up to track 'origin/fix/session-reconnect'.",
        ),
        bash(
          "for i in $(seq 20); do npm test -- session.test.ts || break; done",
          "20 of 20 runs passed",
        ),
        bash(
          "gh pr create --repo acme/app --title 'fix: wait for close before reconnecting in the session test' --body 'Waits for the close event.'",
          "https://github.com/acme/app/pull/57",
        ),
        bash("gh pr checks 57 --repo acme/app", "lint pass\ntest pass"),
      ],
    },
    expect: {
      lead: "fixed|PR|opened|57|flak",
      headMust: ["pull/57"],
    },
    rubric:
      "Fixed: the test now waits for the close event before reconnecting; 20 of 20 runs pass. PR #57 is open with checks green.",
  },
  {
    id: "control-rundown-asked-for",
    kind: "control",
    reply: "report",
    source: "controls C1: 'go over them, compare to previous events, give me a rundown'",
    followUp: "Consolidate the ones that should be consolidated and do number 4 as you recommend.",
    setup: {
      priorTurns: [
        user(
          "It feels like there are a ton of upgrades in this event. How are they balanced and why are there so many? Should we consolidate some? Go over them, compare them to the previous events and give me a rundown.",
        ),
        bash(
          "node scripts/upgrades.mjs --event current",
          "12 tracks, 98 tiers total\n1 coin gain 10 | 2 egg luck 10 | 3 hatch speed 8 | 4 pet damage 10 | 5 walk speed 5 | 6 coin magnet 6 | 7 crit chance 8 | 8 crit damage 8 | 9 drop luck 10 | 10 egg cost 8 | 11 rebirth bonus 10 | 12 auto-tap 5\noverlap: crit chance + crit damage; coin gain + coin magnet; drop luck + egg luck (both roll the same table)\nbarely matter (<1% of progress): walk speed, auto-tap, egg cost",
        ),
        bash(
          "node scripts/upgrades.mjs --history",
          "past events: 11 to 14 tracks since 2025; tiers 60 to 210 (3 events over 190)",
        ),
        bash(
          "cat docs/event-brief.md",
          "Brief asked for '12+ tracks'. The design named 9; 3 were added to reach 12.",
        ),
      ],
    },
    expect: {
      lead: "12|normal|tracks|upgrades",
      bodyMust: ["past|previous|earlier|since 2025", "overlap|filler|consolidat"],
      detailVisible: true,
    },
    rubric:
      "The user asked for a rundown, so the comparison and the per-track reasoning are the answer and must be readable without opening a fold: 12 tracks and 98 tiers is normal against past events; 3 pairs overlap, 3 barely matter, 3 were filler; which to consolidate.",
  },
  {
    id: "control-explain-the-feature",
    kind: "control",
    reply: "report",
    source: "controls C3: 'explain the feature to me, what could we do to polish it?'",
    followUp: "okay so do we have the zones greyboxed so there is a place to do all of this?",
    setup: {
      priorTurns: [
        user(
          "Explain the turkey feature to me. What could we do to polish it and make it more fun?",
        ),
        bash(
          "cat docs/turkey.md",
          "Spawn: every 20 minutes on the clock, same moment on every server, a turkey appears on the centre island.\nGetting there: each island has a cannon to the centre; the centre cannon fires you home.\nFight: it is a big breakable; pets attack it; damage is shared.\nReward: everyone who hit it gets a chest; top damage gets a second roll.\nThin spots: no warning before it spawns; no reason to stay after; the chest is the same every time.",
        ),
      ],
    },
    expect: {
      lead: "turkey|every 20|spawn|breakable|centre",
      bodyMust: ["cannon", "warning|countdown|polish|idea"],
      detailVisible: true,
    },
    rubric:
      "The user asked for an explanation and polish ideas, so how it works and the ideas must be readable without opening a fold.",
  },
  {
    id: "control-break-it-down",
    kind: "control",
    reply: "report",
    source:
      "controls C4: 'break that down for me, all the previous event pets and where they stand'",
    followUp: "let's rebalance them so each previous event sits under the best pet",
    setup: {
      priorTurns: [
        user(
          "So this means it's better than the best pets in the game once you reach zone 279, or what? Break that down for me, all the previous event pets and where they stand.",
        ),
        bash(
          "node scripts/pet-power.mjs --zone 279 --by-event",
          "best zone-279 egg pet: Wicked Kirin, 1.00x\nevent pets above it: 94 of 714\nby event: Fantasy 31 of 40 (best 1.42x) | Winter 22 of 38 (1.30x) | Pinata 2 of 30 (1.04x) | Spring 18 of 36 (1.21x) | Summer 21 of 35 (1.18x) | the 18 older events: 0 (best 0.61x)",
        ),
      ],
    },
    expect: {
      lead: "^no\\b|94|not|only",
      bodyMust: ["fantasy", "winter", "older"],
      detailVisible: true,
    },
    rubric:
      "Line one answers no: only 94 of 714 event pets beat the best zone pet, all from the last five events plus 2 Pinata pets. The per-event breakdown he asked for must be readable without opening a fold.",
  },
  {
    id: "control-how-does-it-work",
    kind: "control",
    reply: "report",
    source: "controls C5: 'help me understand the function of the pumpkin'",
    followUp: "Why would anyone not just continuously break it?",
    setup: {
      priorTurns: [
        user(
          "Help me understand the pumpkin in this update. What's its purpose? Why would someone keep or break it? How does it work?",
        ),
        bash(
          "cat docs/pumpkin.md",
          "Each unlocked zone has a pedestal that grows one pumpkin of random rarity.\nKeep it standing: passive coins per second and +luck for that zone, scaling with rarity.\nBreak it: tokens now plus one roll on the chase table; the next pumpkin regrows in 21 minutes.\nRarity: common 60%, rare 30%, epic 9%, mythic 1%.",
        ),
      ],
    },
    expect: {
      lead: "pumpkin|keep|break|loop",
      bodyMust: ["luck", "token|chase", "regrow|21"],
      detailVisible: true,
    },
    rubric:
      "The user asked how it works, so keep vs break and the mechanics must be readable without opening a fold.",
  },
];
