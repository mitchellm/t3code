import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type Ledger,
  LedgerId,
  LedgerItemId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

/**
 * Investigate mode's chokepoint: once an investigation has ended, nothing but a person's own
 * message (or the investigation's report turn) starts a run anywhere in its thread tree.
 */

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Starting a run never reaches a provider here"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  IdAllocator.layer,
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "investigation-run-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

let counter = 0;
const nextId = (prefix: string) => `${prefix}:${counter++}`;
const projectId = ProjectId.make("project:investigation-hold");

const createThread = (name: string, parentThreadId?: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:hold:${name}:${counter++}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(nextId("create")),
      threadId,
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      // Only the server may make a subagent child, as a delegation does.
      ...(parentThreadId === undefined
        ? { createdBy: "user" as const, creationSource: "web" as const }
        : {
            createdBy: "system" as const,
            creationSource: "server" as const,
            lineage: { parentThreadId, relationshipToParent: "subagent" as const },
          }),
    });
    return threadId;
  });

/** Writes the ledger of an investigation that ended a moment ago, as the planner's commit would. */
const endInvestigation = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const ledger: Ledger = {
      id: LedgerId.make(nextId("ledger:investigation")),
      threadId,
      title: "Why does sync drop rows",
      startState: "",
      checkpoints: [],
      winConditions: ["A failing test passes with the fix."],
      items: [],
      requiresJudge: true,
      investigation: {
        goal: "Why does sync drop rows",
        solvedWhen: "A failing test passes with the fix.",
        budget: { minutes: 30 },
        parallelApproaches: 2,
        status: "solved",
        approachesItemId: LedgerItemId.make("approaches"),
        startedAt: DateTime.subtract(now, { minutes: 5 }),
        endedAt: now,
        endReason: "Approach a survived the refuter.",
      },
      createdAt: now,
      updatedAt: now,
      closedAt: now,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(nextId("event:ledger")),
          type: "ledger.created",
          threadId,
          occurredAt: now,
          payload: ledger,
        },
      ],
    });
  });

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const send = (
  threadId: ThreadId,
  from: Pick<MessageDispatch, "createdBy" | "creationSource"> &
    Partial<Pick<MessageDispatch, "notification">>,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const id = nextId("message");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(id),
      text: "Carry on",
      attachments: [],
      // A server notification is always queued, as its real senders queue it.
      dispatchMode: {
        type: from.notification === undefined ? "start_immediately" : "queue_after_active",
      },
      ...from,
    });
  });

const runsOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* projections.getThreadRecords(threadId, ["runs"])).runs.length;
  });

const noticesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
    return turnItems.filter((item) => item.type === "system_notice");
  });

const autoContinue = {
  createdBy: "agent",
  creationSource: "server",
  notification: {
    source: { kind: "ledger_continue", round: 1, items: [] },
    outcome: "updated",
    summary: "Continuing the task ledger automatically (round 1)",
  },
} as const;

/** A fresh in-memory server per test, as the sibling orchestrator tests do. */
const withRuntime = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layerTest>>) =>
  effect.pipe(Effect.provide(layerTest));

describe("Investigate mode's run hold", () => {
  it.effect("a pull request watch wake after the end starts no run, and says why", () =>
    withRuntime(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const planner = yield* createThread("planner");
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(nextId("watch")),
          threadId: planner,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
        });
        const started = (yield* orchestrator.getThreadShell(planner))?.pullRequests?.[0]?.watch;
        assert.isDefined(started);
        if (started === undefined) return;
        yield* endInvestigation(planner);
        const before = yield* runsOf(planner);
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(nextId("pr-wake")),
          threadId: planner,
          ...key,
          startedAt: started.startedAt,
          watch: { ...started, failedChecks: ["lint"], wakes: 1 },
          wake: {
            messageId: MessageId.make(nextId("message:pr-wake")),
            text: "CI failed on #7.",
            notification: {
              source: { kind: "monitor" },
              outcome: "failed",
              summary: "#7: lint failed",
            },
          },
        });
        assert.strictEqual(yield* runsOf(planner), before);
        assert.lengthOf(yield* noticesOf(planner), 1);
      }),
    ),
  );

  it.effect("auto-continue on a worker after the end starts no run", () =>
    withRuntime(
      Effect.gen(function* () {
        const planner = yield* createThread("planner");
        const worker = yield* createThread("worker", planner);
        yield* endInvestigation(planner);
        yield* send(worker, autoContinue);
        assert.strictEqual(yield* runsOf(worker), 0);
      }),
    ),
  );

  it.effect("the investigation's report turn runs", () =>
    withRuntime(
      Effect.gen(function* () {
        const planner = yield* createThread("planner");
        yield* endInvestigation(planner);
        yield* send(planner, {
          createdBy: "agent",
          creationSource: "server",
          notification: {
            source: { kind: "investigation_report" },
            outcome: "completed",
            summary: "Investigation solved: writing the report",
          },
        });
        assert.strictEqual(yield* runsOf(planner), 1);
      }),
    ),
  );

  it.effect("a message a person typed runs, and a scheduled-looking server wake does not", () =>
    withRuntime(
      Effect.gen(function* () {
        const planner = yield* createThread("planner");
        yield* endInvestigation(planner);
        // The usage-limit resume is stamped as the user's, but from the server.
        yield* send(planner, { createdBy: "user", creationSource: "server" });
        assert.strictEqual(yield* runsOf(planner), 0);
        yield* send(planner, { createdBy: "user", creationSource: "web" });
        assert.strictEqual(yield* runsOf(planner), 1);
      }),
    ),
  );

  it.effect("threads with no investigation are unaffected", () =>
    withRuntime(
      Effect.gen(function* () {
        const plain = yield* createThread("plain");
        yield* send(plain, autoContinue);
        assert.strictEqual(yield* runsOf(plain), 1);
        assert.lengthOf(yield* noticesOf(plain), 0);
      }),
    ),
  );
});
