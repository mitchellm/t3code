import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type Project,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  RelayApi,
  type RelayAgentActivityPublishProofPayload,
  type RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import {
  isWatchedPullRequest,
  turnItemUpdateCanEndBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_ACTIVITY_PUBLISH_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly requestCatchUp: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/AgentAwarenessRelay") {}

function eventThreadId(event: OrchestrationV2DomainEvent): ThreadId {
  return event.threadId;
}

function isTurnItemPayload(
  payload: unknown,
): payload is Pick<OrchestrationV2TurnItem, "type" | "status"> {
  return (
    typeof payload === "object" && payload !== null && "type" in payload && "status" in payload
  );
}

function shouldPublishAgentAwarenessEvent(
  event: Pick<OrchestrationV2DomainEvent, "type"> & { readonly payload?: unknown },
): boolean {
  if (
    event.type === "thread.created" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "historyOrigin" in event.payload &&
    event.payload.historyOrigin === "v1_import"
  ) {
    return false;
  }
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.pull-request-link-updated":
    case "thread.pull-request-synced":
    case "thread.settled":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "provider-thread.updated":
      return true;
    // Unsettling must not re-alert a dismissed result.
    case "thread.unsettled":
    case "thread.guest-share-updated":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.tags-updated":
    case "thread.visited":
    case "thread.marked-unread":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "run.background-work-cancelled":
    case "run-attempt.created":
    case "run-attempt.updated":
    case "node.updated":
    // No published field comes from a subagent record: the shell read never joins the subagents
    // table. A child ending reaches the card through its turn item, the provider thread's task
    // list, or settlement, each of which publishes on its own event.
    case "subagent.updated":
    case "provider-session.attached":
    case "provider-session.updated":
    case "provider-session.detached":
    case "provider-turn.updated":
    case "turn-item.updated":
      return isTurnItemPayload(event.payload) && turnItemUpdateCanEndBackgroundWork(event.payload);
    case "message.updated":
    case "plan.updated":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
    // The relay announces when an agent needs a person (finished, blocked, asking). Ledger
    // bookkeeping is progress inside a run, not one of those moments, and an item flipping
    // state would otherwise ping on every step of a long task.
    case "ledger.created":
    case "ledger.item.added":
    case "ledger.item.updated":
    case "ledger.checkpoint.updated":
    case "ledger.closed":
    case "ledger.investigation.updated":
    case "ledger.reopened":
      return false;
  }
}

export const makeAgentAwarenessPublishWorker = Effect.fnUntraced(function* <R>(
  publish: (threadId: ThreadId) => Effect.Effect<void, never, R>,
) {
  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(Effect.andThen(publish(threadId))),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      // Remove queued IDs when processing starts so publication can queue one later update.
      queued.add(threadId);
      return worker.enqueue(threadId);
    }).pipe(Effect.uninterruptible);
  return { enqueue, drain: worker.drain };
});

/**
 * The thread-record fields the published card is built from: where it lives, its title and model,
 * whether it is archived or settled, and which watched pull requests hold a completion open. A
 * thread event whose payload matches what the last publish read cannot change the card.
 */
function awarenessThreadInputs(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "projectId"
    | "title"
    | "modelSelection"
    | "archivedAt"
    | "settledOverride"
    | "lineage"
    | "activeProviderThreadId"
    | "pullRequests"
  >,
): string {
  return JSON.stringify([
    thread.projectId,
    thread.title,
    thread.modelSelection.model,
    thread.archivedAt !== null,
    thread.settledOverride,
    thread.lineage,
    thread.activeProviderThreadId,
    (thread.pullRequests ?? [])
      .filter(isWatchedPullRequest)
      .map((link) => `${link.host}/${link.repository}#${link.number}`)
      .toSorted(),
  ]);
}

/**
 * The card's baseline: what the last confirmed publish read, one field per input an event family
 * can move. An event whose payload proves its inputs still match skips the reads; anything a
 * payload cannot prove reads, since a missed change leaves a stale card.
 */
interface PublishedAwarenessInputs {
  readonly thread: string;
  readonly watchedPullRequests: ReadonlySet<string>;
  readonly activeProviderThreadId: string | null;
  readonly latestRunId: string | null;
  readonly status: string;
  readonly pendingRequest: {
    readonly id: string;
    readonly kind: string;
    readonly blocking: boolean;
  } | null;
}

// Lowercased like the pending-work task id, so a link cannot dodge the lookup by letter case.
function pullRequestKey(link: Pick<ThreadPullRequestLink, "host" | "repository" | "number">) {
  return `${link.host}/${link.repository}#${link.number}`.toLowerCase();
}

function publishedAwarenessInputs(shell: OrchestrationV2ThreadShell): PublishedAwarenessInputs {
  return {
    thread: awarenessThreadInputs(shell),
    watchedPullRequests: new Set(
      (shell.pullRequests ?? []).filter(isWatchedPullRequest).map(pullRequestKey),
    ),
    activeProviderThreadId: shell.activeProviderThreadId,
    latestRunId: shell.latestRunId ?? null,
    status: shell.status,
    pendingRequest:
      shell.pendingRuntimeRequest == null
        ? null
        : {
            id: shell.pendingRuntimeRequest.id,
            kind: shell.pendingRuntimeRequest.kind,
            blocking: shell.pendingRuntimeRequest.blocking !== false,
          },
  };
}

// The shell only carries the merged task list, so the provider thread's own list is compared with
// the one its previous event carried. A task's identity and kind are all the card can depend on.
function backgroundTasksSignature(
  tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly kind: string;
    readonly awaited?: boolean | undefined;
  }>,
): string {
  return JSON.stringify(
    tasks
      .filter((task) => task.taskId.length > 0)
      .map((task) => `${task.taskId}|${task.kind}|${task.awaited === true}`)
      .toSorted(),
  );
}

/**
 * True when the event's own payload proves every published input it can move still matches the
 * baseline. The run rule compares the latest run's id and status, the only run fields the shell's
 * status and activity read; any other run, or a held one, reads. A pending request is judged by
 * whether it is the displayed one; a request that was never displayed cannot move the card.
 */
function payloadMatchesPublishedAwareness(
  published: PublishedAwarenessInputs,
  event: OrchestrationV2DomainEvent,
): boolean {
  switch (event.type) {
    // These carry the whole thread record and fire often (PR syncs, branch and title churn).
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.settled":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.archived":
    case "thread.unarchived":
      return published.thread === awarenessThreadInputs(event.payload);
    case "run.created":
    case "run.updated":
      return (
        typeof event.payload.id === "string" &&
        event.payload.id === published.latestRunId &&
        event.payload.status === published.status &&
        event.payload.queueHeld !== true
      );
    case "runtime-request.updated": {
      const request = event.payload;
      if (typeof request.id !== "string" || typeof request.status !== "string") return false;
      const pending = published.pendingRequest;
      if (request.status !== "pending") return pending === null || pending.id !== request.id;
      return (
        request.responseCapability !== undefined &&
        pending !== null &&
        pending.id === request.id &&
        pending.kind === request.kind &&
        pending.blocking === (request.responseCapability.type !== "message")
      );
    }
    case "thread.pull-request-link-updated": {
      const link = event.payload;
      if (
        typeof link.host !== "string" ||
        typeof link.repository !== "string" ||
        typeof link.number !== "number"
      ) {
        return false;
      }
      return published.watchedPullRequests.has(pullRequestKey(link)) === isWatchedPullRequest(link);
    }
    default:
      return false;
  }
}

function agentAwarenessPublishIdentity(state: RelayAgentActivityState | null): string {
  if (state === null) {
    return "null";
  }
  const { updatedAt: _updatedAt, ...meaningfulState } = state;
  return JSON.stringify(meaningfulState);
}

function resolveAgentActivityPublishingStartupState(input: {
  readonly relayConfigured: boolean;
  readonly publishEnabled: boolean;
}): "waiting-for-link" | "disabled" | "enabled" {
  if (!input.relayConfigured) {
    return "waiting-for-link";
  }
  return input.publishEnabled ? "enabled" : "disabled";
}

const PUBLISH_CONFIG_TTL_MS = 30_000;
const UNLISTED_THREADS_MAX = 10_000;
const RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH = 160;
const REDACTED_RELAY_AGENT_FAILURE_DETAIL = "The agent run failed.";
const RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

function sanitizeRelayAgentActivityState(
  state: RelayAgentActivityState | null,
): RelayAgentActivityState | null {
  if (state === null) {
    return null;
  }
  const { detail: _detail, ...rest } = state;
  const detail = (state.phase === "failed" ? REDACTED_RELAY_AGENT_FAILURE_DETAIL : state.detail)
    ?.trim()
    .slice(0, RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH)
    .trim();
  return detail ? { ...rest, detail } : rest;
}

function relayEnvironmentClient(token: string) {
  return HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
}

function deliveryStats(
  deliveries: ReadonlyArray<{
    readonly ok: boolean;
    readonly queued?: boolean | undefined;
    readonly kind: string;
    readonly apnsStatus?: number | null;
    readonly apnsReason?: string | null;
  }>,
) {
  let queued = 0;
  let successful = 0;
  let failed = 0;
  const failedReasons: string[] = [];
  const kinds = new Set<string>();

  for (const delivery of deliveries) {
    kinds.add(delivery.kind);
    if (delivery.queued) {
      queued += 1;
      continue;
    }
    if (delivery.ok) {
      successful += 1;
      continue;
    }
    failed += 1;
    failedReasons.push(`${delivery.apnsStatus ?? "transport"}:${delivery.apnsReason ?? "unknown"}`);
  }

  return {
    total: deliveries.length,
    queued,
    successful,
    failed,
    kinds: [...kinds],
    failedReasons,
  };
}

function signRelayAgentActivityPublishProof(input: {
  readonly privateKey: string;
  readonly payload: RelayAgentActivityPublishProofPayload;
}) {
  return signRelayJwt({
    privateKey: input.privateKey,
    typ: RELAY_ACTIVITY_PUBLISH_TYP,
    payload: input.payload,
  });
}

const makePublishProof = Effect.fn("makePublishProof")(function* (input: {
  readonly privateKey: string;
  readonly relayIssuer: string;
  readonly environmentId: string;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly jti: string;
}) {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const payload = {
    iss: `t3-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(input.relayIssuer),
    sub: input.environmentId,
    jti: input.jti,
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    environmentId: input.environmentId as RelayAgentActivityPublishProofPayload["environmentId"],
    threadId: input.threadId,
    state: input.state,
  } satisfies RelayAgentActivityPublishProofPayload;
  return yield* signRelayAgentActivityPublishProof({ privateKey: input.privateKey, payload });
});

function describeThreadShellForAwareness(
  thread: Option.Option<OrchestrationV2ThreadShell>,
): Record<string, unknown> {
  if (Option.isNone(thread)) {
    return { found: false };
  }
  const shell = thread.value;
  return {
    found: true,
    status: shell.status,
    activityRunStatus: shell.activityRunStatus ?? null,
    activeRunId: shell.activeRunId ?? null,
    latestRunId: shell.latestRunId ?? null,
    pendingRuntimeRequestKind: shell.pendingRuntimeRequest?.kind ?? null,
    hasActionableProposedPlan: shell.hasActionableProposedPlan,
  };
}

function resolveAgentAwarenessRelayPublishSnapshot(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Option.Option<OrchestrationV2ThreadShell>;
  readonly project: Option.Option<Project>;
}): {
  readonly projectId: string | null;
  readonly state: RelayAgentActivityState | null;
  readonly reason: "snapshot" | "thread-not-found" | "project-not-found";
} {
  if (Option.isNone(input.thread)) {
    return {
      projectId: null,
      state: null,
      reason: "thread-not-found",
    };
  }
  if (Option.isNone(input.project)) {
    return {
      projectId: input.thread.value.projectId,
      state: null,
      reason: "project-not-found",
    };
  }
  return {
    projectId: input.thread.value.projectId,
    state: sanitizeRelayAgentActivityState(
      projectThreadAwarenessV2({
        environmentId: input.environmentId,
        project: input.project.value,
        thread: input.thread.value,
      }),
    ),
    reason: "snapshot",
  };
}

function terminalWorkSinceStart(thread: OrchestrationV2ThreadShell, startedAt: number): boolean {
  return (
    thread.latestRunCompletedAt != null &&
    DateTime.toEpochMillis(thread.latestRunCompletedAt) > startedAt
  );
}

export function resolveAgentAwarenessRelayActiveThreadIds(input: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: number;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "title">>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}): ReadonlyArray<ThreadId> {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  return input.threads
    .filter((thread) => {
      const project = projectById.get(thread.projectId);
      if (!project) {
        return false;
      }
      const state = projectThreadAwarenessV2({
        environmentId: input.environmentId,
        project,
        thread,
      });
      return (
        state !== null &&
        (state.phase !== "completed" && state.phase !== "failed"
          ? true
          : terminalWorkSinceStart(thread, input.startedAt))
      );
    })
    .map((thread) => thread.id);
}

/** @public */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const cloudLinkKeyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  const startedAt = (yield* DateTime.now).epochMilliseconds;
  const catchUpRequests = yield* Queue.dropping<void>(1);
  const publishedStateByThreadRef = yield* Ref.make(new Map<ThreadId, string>());
  // Inputs of the state last confirmed published, so an event whose payload proves they still
  // match skips the shell and project reads. Only a full read of a listed thread seeds it, and a
  // read drops it first: an event arriving while a publish is in flight must not be judged against
  // a baseline that publish is about to replace.
  const publishedInputs = new Map<ThreadId, PublishedAwarenessInputs>();
  // Per thread, each provider thread's pending-task signature as of its latest event.
  const observedProviderTasks = new Map<ThreadId, Map<string, string>>();
  const unlistedThreads = new Set<ThreadId>();
  const rememberUnlistedThread = (threadId: ThreadId) => {
    // Bounded so a long-lived server cannot grow it without limit; a miss only costs one shell read.
    if (unlistedThreads.size >= UNLISTED_THREADS_MAX) unlistedThreads.clear();
    unlistedThreads.add(threadId);
  };

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
      );

  const readRelayConfig = Effect.gen(function* () {
    const [url, issuer, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ISSUER_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    return url && environmentCredential
      ? { url, issuer: issuer ?? url, environmentCredential }
      : null;
  });

  const readPublishAgentActivityEnabled = readSecretString(PUBLISH_AGENT_ACTIVITY_SECRET).pipe(
    Effect.map(isAgentActivityPublishingEnabledValue),
  );

  const makeRelayClient = (relayConfig: {
    readonly url: string;
    readonly environmentCredential: string;
  }) =>
    HttpApiClient.make(RelayApi, {
      baseUrl: relayConfig.url,
      transformClient: relayEnvironmentClient(relayConfig.environmentCredential),
    }).pipe(Effect.provide(FetchHttpClient.layer));

  // The per-event publish path used to read four secrets on every call, 98% of all secret reads.
  // Link and publish-preference writes in this process call `requestCatchUp`, which drops the
  // cache. `t3 connect` and unlink run elsewhere with no signal, so the TTL bounds how stale it gets.
  let cachedPublishConfig:
    | {
        readonly enabled: boolean;
        readonly relayConfig: Effect.Success<typeof readRelayConfig>;
        readonly expiresAtMs: number;
      }
    | undefined;
  let publishConfigGeneration = 0;
  const invalidatePublishConfig = Effect.sync(() => {
    publishConfigGeneration += 1;
    cachedPublishConfig = undefined;
  });
  const readPublishConfig = Effect.gen(function* () {
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    if (cachedPublishConfig !== undefined && nowMs < cachedPublishConfig.expiresAtMs) {
      return cachedPublishConfig;
    }
    const generation = publishConfigGeneration;
    const enabled = yield* readPublishAgentActivityEnabled;
    const relayConfig = enabled ? yield* readRelayConfig : null;
    const fresh = { enabled, relayConfig, expiresAtMs: nowMs + PUBLISH_CONFIG_TTL_MS };
    // A signal that arrived while the secrets were being read must not be overwritten by them.
    if (generation === publishConfigGeneration) cachedPublishConfig = fresh;
    return fresh;
  });

  let cachedRelayClient: Effect.Success<ReturnType<typeof makeRelayClient>> | undefined;
  let publishedRelayConfig: NonNullable<Effect.Success<typeof readRelayConfig>> | undefined;

  // Confirm through the same worker so tombstones cannot race live updates; recovery clears the deadline.
  const publishConfirmDeadlines = new Map<ThreadId, number>();
  // Threads whose confirmation holds a completion, so a thread that settles during the hold still alerts.
  const heldCompletions = new Set<ThreadId>();
  let schedulePublishConfirm: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  const publishRetries = new Map<
    ThreadId,
    { readonly attempts: number; timer: Fiber.Fiber<void> | undefined }
  >();
  const cancelPublishRetry = Effect.fnUntraced(function* (threadId: ThreadId) {
    const retry = publishRetries.get(threadId);
    publishRetries.delete(threadId);
    if (retry?.timer !== undefined) yield* Fiber.interrupt(retry.timer);
  });
  const cancelPublishRetries = Effect.suspend(() =>
    Effect.forEach([...publishRetries.keys()], cancelPublishRetry, { discard: true }),
  );
  let schedulePublishRetry: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  const resetPublishedConnection = Effect.gen(function* () {
    publishedRelayConfig = undefined;
    cachedRelayClient = undefined;
    publishConfirmDeadlines.clear();
    heldCompletions.clear();
    publishedInputs.clear();
    observedProviderTasks.clear();
    yield* Ref.set(publishedStateByThreadRef, new Map());
  });

  const publishThreadUnsafe = Effect.fn("publishThreadUnsafe")(function* (threadId: ThreadId) {
    const { enabled: publishAgentActivity, relayConfig } = yield* readPublishConfig;
    if (!publishAgentActivity) {
      yield* cancelPublishRetries;
      yield* resetPublishedConnection;
      yield* Effect.logDebug("agent activity publish skipped; publication disabled", {
        threadId,
      });
      return;
    }
    if (!relayConfig) {
      yield* cancelPublishRetries;
      yield* resetPublishedConnection;
      yield* Effect.logDebug("agent activity publish skipped; relay link credentials unavailable", {
        threadId,
      });
      return;
    }
    if (
      publishedRelayConfig?.url !== relayConfig.url ||
      publishedRelayConfig.issuer !== relayConfig.issuer ||
      publishedRelayConfig.environmentCredential !== relayConfig.environmentCredential
    ) {
      yield* resetPublishedConnection;
      publishedRelayConfig = relayConfig;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;

    const publishState = Effect.fn("relay.agent_activity.publish")(function* (input: {
      readonly projectId: string | null;
      readonly state: RelayAgentActivityState | null;
      readonly reason: string;
    }) {
      if (cachedRelayClient === undefined) {
        cachedRelayClient = yield* makeRelayClient(relayConfig);
      }
      const relayClient = cachedRelayClient;
      const proof = yield* makePublishProof({
        privateKey: cloudLinkKeyPair.privateKey,
        relayIssuer: relayConfig.issuer,
        environmentId,
        threadId,
        state: input.state,
        jti: yield* crypto.randomUUIDv4(),
      });

      yield* Effect.logInfo("publishing agent activity for thread", {
        environmentId,
        threadId,
        projectId: input.projectId,
        statePhase: input.state?.phase ?? null,
        hasState: input.state !== null,
        reason: input.reason,
      });

      const response = yield* relayClient.server
        .publishAgentActivity({
          params: {
            environmentId,
            threadId,
          },
          payload: {
            state: input.state,
            proof,
          },
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* Effect.logInfo("agent activity publish completed", {
        environmentId,
        threadId,
        ok: response.ok,
        deliveries: deliveryStats(response.deliveries),
      });
    });

    // Subagents and side chats have no relay rows to clear; per-event tombstones would needlessly redeliver user aggregates.
    // Lineage is fixed at creation, so a thread seen as unlisted once costs no shell read afterwards.
    if (
      unlistedThreads.has(threadId) &&
      !(yield* Ref.get(publishedStateByThreadRef)).has(threadId)
    ) {
      return;
    }
    publishedInputs.delete(threadId);
    // Read only this thread; full shell reads would make each activity event scale with all threads.
    const threadShell = yield* threads.getThreadShell(threadId);
    if (threadShell !== null && !isListedThreadLineage(threadShell.lineage)) {
      rememberUnlistedThread(threadId);
      if (!(yield* Ref.get(publishedStateByThreadRef)).has(threadId)) {
        return;
      }
    }
    const thread =
      threadShell === null || threadShell.archivedAt !== null
        ? Option.none<OrchestrationV2ThreadShell>()
        : Option.some(threadShell);
    const project = Option.isSome(thread)
      ? yield* projects.getById(thread.value.projectId)
      : Option.none<Project>();
    const snapshot = resolveAgentAwarenessRelayPublishSnapshot({
      environmentId,
      thread,
      project,
    });
    const publishIdentity = agentAwarenessPublishIdentity(snapshot.state);
    const publishedStateByThread = yield* Ref.get(publishedStateByThreadRef);
    if (
      (snapshot.state?.phase === "completed" || snapshot.state?.phase === "failed") &&
      !publishedStateByThread.has(threadId)
    ) {
      if (Option.isNone(thread) || !terminalWorkSinceStart(thread.value, startedAt)) return;
    }
    const rememberPublishedInputs = () => {
      if (threadShell !== null && snapshot.reason === "snapshot") {
        publishedInputs.set(threadId, publishedAwarenessInputs(threadShell));
      } else {
        observedProviderTasks.delete(threadId);
      }
    };
    if (publishedStateByThread.get(threadId) === publishIdentity) {
      rememberPublishedInputs();
      // Clear moot deadlines so later transient nulls cannot skip their deferral window.
      publishConfirmDeadlines.delete(threadId);
      heldCompletions.delete(threadId);
      yield* Effect.logDebug("agent activity publish skipped; projected state unchanged", {
        environmentId,
        threadId,
        reason: snapshot.reason,
      });
      return;
    }

    // Confirm tombstones over live state to avoid removing active cards.
    // Confirm completion: a run can end moments before its continuation starts, and the relay
    // alerts on every move into completed.
    const requiresConfirmation =
      (snapshot.state === null &&
        publishedStateByThread.get(threadId) !== agentAwarenessPublishIdentity(null)) ||
      snapshot.state?.phase === "completed";
    if (requiresConfirmation) {
      if (snapshot.state?.phase === "completed") heldCompletions.add(threadId);
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const deadline = publishConfirmDeadlines.get(threadId);
      if (deadline === undefined) {
        publishConfirmDeadlines.set(threadId, nowMs + 5_000);
        yield* Effect.logInfo("agent activity publish deferred pending confirmation", {
          environmentId,
          threadId,
          reason: snapshot.reason,
          statePhase: snapshot.state?.phase ?? null,
          shell: describeThreadShellForAwareness(thread),
        });
        yield* schedulePublishConfirm(threadId);
        return;
      }
      if (nowMs < deadline) {
        return;
      }
      yield* Effect.logInfo("agent activity deferred publish confirmed", {
        environmentId,
        threadId,
        reason: snapshot.reason,
        statePhase: snapshot.state?.phase ?? null,
        shell: describeThreadShellForAwareness(thread),
      });
      // Settled during the hold, not resumed: alert the current completion, then clear the card
      // on a new window. Only settlement may hide it; queued or silent runs also project to null.
      const unsettled =
        snapshot.state === null &&
        heldCompletions.has(threadId) &&
        Option.isSome(thread) &&
        thread.value.settledOverride === "settled"
          ? resolveAgentAwarenessRelayPublishSnapshot({
              environmentId,
              thread: Option.some({ ...thread.value, settledOverride: null }),
              project,
            })
          : null;
      if (unsettled?.state?.phase === "completed") {
        const completion = unsettled.state;
        yield* publishState({
          projectId: unsettled.projectId,
          state: completion,
          reason: unsettled.reason,
        }).pipe(withRelayClientTracing);
        heldCompletions.delete(threadId);
        publishConfirmDeadlines.set(threadId, nowMs + 5_000);
        yield* Ref.update(publishedStateByThreadRef, (publishedStates) =>
          new Map(publishedStates).set(threadId, agentAwarenessPublishIdentity(completion)),
        );
        yield* schedulePublishConfirm(threadId);
        return;
      }
    } else {
      publishConfirmDeadlines.delete(threadId);
      heldCompletions.delete(threadId);
    }

    if (snapshot.reason === "thread-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; thread not found", {
        environmentId,
        threadId,
      });
    } else if (snapshot.reason === "project-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; project not found", {
        environmentId,
        threadId,
        projectId: snapshot.projectId,
      });
    }

    yield* publishState({
      projectId: snapshot.projectId,
      state: snapshot.state,
      reason: snapshot.reason,
    }).pipe(withRelayClientTracing);
    rememberPublishedInputs();
    publishConfirmDeadlines.delete(threadId);
    heldCompletions.delete(threadId);
    yield* Ref.update(publishedStateByThreadRef, (publishedStates) => {
      const nextPublishedStates = new Map(publishedStates);
      if (snapshot.state === null) {
        nextPublishedStates.delete(threadId);
      } else {
        nextPublishedStates.set(threadId, publishIdentity);
      }
      return nextPublishedStates;
    });
  });

  const processThreadPublish = Effect.fnUntraced(function* (threadId: ThreadId) {
    const retry = publishRetries.get(threadId);
    if (retry?.timer !== undefined) {
      const timer = retry.timer;
      retry.timer = undefined;
      yield* Fiber.interrupt(timer);
    }
    yield* publishThreadUnsafe(threadId).pipe(
      Effect.tap(() => cancelPublishRetry(threadId)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        return Effect.logWarning("agent activity publish failed", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(schedulePublishRetry(threadId)));
      }),
      Effect.withSpan("AgentAwarenessRelay.publishThread"),
    );
  });

  const worker = yield* makeAgentAwarenessPublishWorker(processThreadPublish);
  const enqueueThreadPublish = (threadId: ThreadId) =>
    cancelPublishRetry(threadId).pipe(Effect.andThen(worker.enqueue(threadId)));
  const publishThread: AgentAwarenessRelay["Service"]["publishThread"] = (threadId) =>
    enqueueThreadPublish(threadId).pipe(Effect.andThen(worker.drain));

  schedulePublishRetry = Effect.fnUntraced(function* (threadId: ThreadId) {
    const attempts = publishRetries.get(threadId)?.attempts ?? 0;
    const delayMs = RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS[attempts];
    if (delayMs === undefined) {
      // Retain exhausted budgets until activity or success resets them; old timers must not restart retries.
      yield* Effect.logWarning("agent activity publish retry budget exhausted", { threadId });
      return;
    }
    const retry = {
      attempts: attempts + 1,
      timer: undefined as Fiber.Fiber<void> | undefined,
    };
    publishRetries.set(threadId, retry);
    const timer = yield* Effect.sleep(delayMs).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (publishRetries.get(threadId) !== retry) return Effect.void;
          retry.timer = undefined;
          return worker.enqueue(threadId);
        }),
      ),
      Effect.forkIn(scope),
    );
    if (publishRetries.get(threadId) !== retry) {
      yield* Fiber.interrupt(timer);
    } else {
      retry.timer = timer;
    }
  });

  const publishActiveThreadsUnsafe = Effect.gen(function* () {
    const relayUrl = yield* readSecretString(RELAY_URL_SECRET).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!relayUrl) {
      yield* Effect.logDebug("agent activity snapshot skipped; relay link credentials unavailable");
      return "unlinked" as const;
    }
    const publishAgentActivity = yield* readPublishAgentActivityEnabled.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!publishAgentActivity) {
      yield* Effect.logDebug("agent activity snapshot skipped; publication disabled");
      return "disabled" as const;
    }
    const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
    if (!relayConfig) {
      yield* Effect.logDebug("agent activity snapshot skipped; relay link credentials unavailable");
      return "unlinked" as const;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const projectSnapshot = yield* projects.snapshot;
    // Subagents and side chats never publish awareness, and subagents are most threads.
    const topLevelThreadIds = (yield* threads.listActiveShellIndex()).flatMap((thread) =>
      isListedThreadLineage(thread.lineage) ? [thread.id] : [],
    );
    const shellSnapshot = yield* threads.getShellSnapshot({
      location: "active",
      threadIds: topLevelThreadIds,
    });
    const activeThreadIds = resolveAgentAwarenessRelayActiveThreadIds({
      environmentId,
      startedAt,
      projects: projectSnapshot.projects,
      threads: shellSnapshot.threads,
    });
    if (activeThreadIds.length === 0) {
      yield* Effect.logDebug("agent activity snapshot has no publishable threads");
      return "published" as const;
    }
    yield* Effect.logInfo("publishing active agent activity snapshot", {
      count: activeThreadIds.length,
    });
    yield* Effect.forEach(activeThreadIds, enqueueThreadPublish, { discard: true });
    yield* worker.drain;
    return "published" as const;
  });

  // Many environments never link, so while unlinked the retry backs off from 5
  // s to 60 s. A linked environment keeps the 5 s retry, because `t3 connect
  // publish` can turn publishing on from another process. Keep this untraced:
  // an unlinked environment can retry for the lifetime of the process.
  const publishActiveThreadsWhenConfigured = Effect.fnUntraced(function* (
    logEnabledWhenReady: boolean,
  ) {
    let unlinkedRetryDelayMs = 5_000;
    while (true) {
      const result = yield* publishActiveThreadsUnsafe.pipe(
        Effect.orElseSucceed(() => "failed" as const),
      );
      if (result === "published") {
        if (logEnabledWhenReady) {
          const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
          yield* Effect.logInfo("agent activity publishing enabled after link reconciliation", {
            relayUrl: relayConfig?.url,
          });
        }
        logEnabledWhenReady = false;
        unlinkedRetryDelayMs = 5_000;
        yield* Queue.take(catchUpRequests);
        continue;
      }
      const retryDelayMs = result === "unlinked" ? unlinkedRetryDelayMs : 5_000;
      yield* Effect.race(Effect.sleep(retryDelayMs), Queue.take(catchUpRequests));
      if (result === "unlinked") {
        unlinkedRetryDelayMs = Math.min(unlinkedRetryDelayMs * 2, 60_000);
      }
    }
  });

  schedulePublishConfirm = (threadId) =>
    Effect.forkIn(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(worker.enqueue(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("deferred agent activity confirmation failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
      scope,
    ).pipe(Effect.asVoid);

  // True when this provider thread's pending-task list matches the one its previous event carried.
  // The first event for a provider thread has nothing to match, so it reads.
  const observeProviderTasks = (
    threadId: ThreadId,
    providerThread: OrchestrationV2ProviderThread,
  ): boolean => {
    if (
      typeof providerThread.id !== "string" ||
      !Array.isArray(providerThread.pendingBackgroundTasks)
    ) {
      return false;
    }
    const signature = backgroundTasksSignature(providerThread.pendingBackgroundTasks);
    const observed = observedProviderTasks.get(threadId) ?? new Map<string, string>();
    const unchanged = observed.get(providerThread.id) === signature;
    observed.set(providerThread.id, signature);
    observedProviderTasks.set(threadId, observed);
    return unchanged;
  };

  const start: AgentAwarenessRelay["Service"]["start"] = Effect.fn("AgentAwarenessRelay.start")(
    function* () {
      const [relayConfig, publishEnabled] = yield* Effect.all([
        readRelayConfig.pipe(Effect.orElseSucceed(() => null)),
        readPublishAgentActivityEnabled.pipe(Effect.orElseSucceed(() => false)),
      ]);
      const startupState = resolveAgentActivityPublishingStartupState({
        relayConfigured: relayConfig !== null,
        publishEnabled,
      });
      switch (startupState) {
        case "waiting-for-link":
          yield* Effect.logInfo(
            "agent activity publishing standby; waiting for T3 Connect link reconciliation",
          );
          break;
        case "disabled":
          yield* Effect.logInfo("agent activity publishing disabled by T3 Connect configuration");
          break;
        case "enabled":
          yield* Effect.logInfo("agent activity publishing enabled", {
            relayUrl: relayConfig?.url,
          });
          break;
      }
      yield* forkParked(
        Effect.sleep("1 second").pipe(
          Effect.andThen(publishActiveThreadsWhenConfigured(startupState !== "enabled")),
        ),
      );
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) => {
          const threadId = eventThreadId(event);
          if (event.type === "thread.created" && !isListedThreadLineage(event.payload.lineage)) {
            rememberUnlistedThread(threadId);
          } else if (event.type === "thread.deleted") {
            unlistedThreads.delete(threadId);
            publishedInputs.delete(threadId);
            observedProviderTasks.delete(threadId);
          }
          if (!shouldPublishAgentAwarenessEvent(event)) {
            return Effect.void;
          }
          // A thread without a confirmed publish, and any event whose payload cannot prove the
          // inputs it moves are unchanged, still reads.
          const published = publishedInputs.get(threadId);
          // Observed on every provider-thread event, so the comparison is always against the
          // latest one whether or not this event is skipped.
          const providerTasksUnchanged =
            event.type === "provider-thread.updated" &&
            observeProviderTasks(threadId, event.payload) &&
            published?.activeProviderThreadId === event.payload.id;
          if (
            published !== undefined &&
            (providerTasksUnchanged || payloadMatchesPublishedAwareness(published, event))
          ) {
            return Effect.void;
          }
          return Effect.logDebug("agent activity publishing queued thread publish", {
            eventType: event.type,
            threadId,
          }).pipe(Effect.andThen(enqueueThreadPublish(threadId)));
        }),
      );
    },
  );

  return AgentAwarenessRelay.of({
    publishThread,
    drain: worker.drain,
    requestCatchUp: Effect.fn("AgentAwarenessRelay.requestCatchUp")(function () {
      return invalidatePublishConfig.pipe(
        Effect.andThen(Queue.offer(catchUpRequests, undefined)),
        Effect.asVoid,
      );
    }),
    start,
  });
});

export const layer = Layer.effect(AgentAwarenessRelay, make);
