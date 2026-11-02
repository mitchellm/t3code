import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  sshTargetKey,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import { APP_VERSION } from "../branding";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import {
  DESKTOP_TOPOLOGY_CHANGED_EVENT,
  desktopLocalConnectionId,
  readDesktopSecondaryBootstrapsResult,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import * as ConnectionStorage from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

// change also fires for same-network bandwidth and latency estimates; count only type changes.
const networkPathChanges = Stream.callback<"network-changed">((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const connection =
        typeof navigator === "undefined"
          ? undefined
          : (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;
      if (connection?.type === undefined) return undefined;
      let previous = connection.type;
      const listener = () => {
        const type = connection.type;
        if (type === undefined || type === previous) return;
        previous = type;
        Queue.offerUnsafe(queue, "network-changed");
      };
      connection.addEventListener("change", listener);
      return { connection, listener };
    }),
    (subscription) =>
      Effect.sync(() =>
        subscription?.connection.removeEventListener("change", subscription.listener),
      ),
  ).pipe(Effect.asVoid),
);

const layerWakeups = Wakeups.layer({
  changes: Stream.mergeAll(
    [
      Stream.callback<"application-active">((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => {
              if (document.visibilityState === "visible") {
                Queue.offerUnsafe(queue, "application-active");
              }
            };
            document.addEventListener("visibilitychange", listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              document.removeEventListener("visibilitychange", listener);
            }),
        ).pipe(Effect.asVoid),
      ),
      managedRelayAccountChanges(appAtomRegistry).pipe(
        Stream.map(() => "credentials-changed" as const),
      ),
      networkPathChanges,
    ],
    { concurrency: "unbounded" },
  ),
});

export function currentClientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: isHostedStaticApp(),
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

// IPC keeps running after its waiter is interrupted. A retry can adopt only
// that interrupted waiter's unfinished setup.
const pendingSshSetups = new Map<
  string,
  { readonly promise: Promise<DesktopSshEnvironmentBootstrap>; signal: AbortSignal }
>();

const ensureDesktopSshEnvironment = (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) =>
  Effect.tryPromise({
    try: (signal) => {
      const key = sshTargetKey(target);
      const pending = pendingSshSetups.get(key);
      if (pending?.signal.aborted) {
        pending.signal = signal;
        return pending.promise;
      }
      const setup = {
        promise: bridge.ensureSshEnvironment(target, { issuePairingToken: true }),
        signal,
      };
      pendingSshSetups.set(key, setup);
      const forget = () => {
        if (pendingSshSetups.get(key) === setup) pendingSshSetups.delete(key);
      };
      setup.promise.then(forget, forget);
      return setup.promise;
    },
    catch: sshPreparationError,
  });

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (
  bridge: DesktopBridge,
  target: DesktopSshEnvironmentTarget,
  expectedEnvironmentId?: EnvironmentId,
) {
  const bootstrap = yield* ensureDesktopSshEnvironment(bridge, target);
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  if (expectedEnvironmentId !== undefined && descriptor.environmentId !== expectedEnvironmentId) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `That host reaches ${descriptor.label}, a different machine. Add it as its own environment instead.`,
    });
  }
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: (cause) => {
      const error = sshPreparationError(cause);
      // A reused remote server on another build can fail to decode the grant
      // the desktop's runner just minted, and answers 500 on every retry.
      if (
        error._tag === "ConnectionBlockedError" ||
        descriptor.serverVersion === APP_VERSION ||
        !error.detail.includes("[ssh_http:500]")
      ) {
        return error;
      }
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: `${descriptor.label} runs T3 Code ${descriptor.serverVersion}, but this desktop is ${APP_VERSION}, and that server could not accept its pairing. Restart the T3 server on ${descriptor.label} so it runs ${APP_VERSION}, then retry.`,
      });
    },
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

/** Reuses SSH pairing tokens with all standard scopes to avoid adding a session on each connection. */
export const prepareDesktopSshEnvironment = Effect.fn("web.connectionPlatform.ssh.prepareDesktop")(
  function* (
    bridge: DesktopBridge,
    input: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly bearerToken?: string;
    },
  ) {
    const bearerToken = input.bearerToken;
    if (bearerToken !== undefined) {
      const bootstrap = yield* Effect.tryPromise({
        try: () => bridge.ensureSshEnvironment(input.target, { issuePairingToken: false }),
        catch: sshPreparationError,
      });
      // Check identity before sending saved credentials or pairing.
      const descriptor = yield* Effect.tryPromise({
        try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
        catch: sshPreparationError,
      });
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: `That host reaches ${descriptor.label}, a different machine. Add it as its own environment instead.`,
        });
      }
      const session = yield* Effect.tryPromise({
        try: () => bridge.fetchSshSessionState(bootstrap.httpBaseUrl, bearerToken),
        catch: sshPreparationError,
      });
      // Stored grants never widen; re-pair tokens missing newer standard scopes.
      const granted = session.permissions ?? session.scopes ?? [];
      if (
        session.authenticated &&
        AuthStandardClientScopes.every((scope) => granted.includes(scope))
      ) {
        return { bootstrap, bearerToken };
      }
    }
    const provisioned = yield* provisionDesktopSshEnvironment(
      bridge,
      input.target,
      input.expectedEnvironmentId,
    );
    return { bootstrap: provisioned.bootstrap, bearerToken: provisioned.bearerToken };
  },
);

const ANALYTICS_DEVICE_ID_KEY = "t3code:analytics-device-id";

// Lives as long as this browser profile's site data. Storage can be blocked, which only drops the id.
const analyticsDevice = {
  id: Effect.try(() => {
    const existing = window.localStorage.getItem(ANALYTICS_DEVICE_ID_KEY);
    if (existing) return existing;
    const created = randomUUID();
    window.localStorage.setItem(ANALYTICS_DEVICE_ID_KEY, created);
    return created;
  }).pipe(Effect.option),
};

const layerCapabilities = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientCapabilities.ClientPresentation.of({
      metadata: currentClientMetadata(),
    });
    const cloudSession = ClientCapabilities.CloudSession.of({
      identity: Effect.sync(() =>
        Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
      ),
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (session === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Sign in to T3 Connect to connect this environment.",
          });
        }
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "network",
                detail: error.message,
              }),
          ),
        );
        if (token === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The T3 Connect session is unavailable.",
          });
        }
        return token;
      }),
    });
    const identity = ClientCapabilities.RelayDeviceIdentity.of({
      deviceId: Effect.succeedNone,
    });
    const primaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = ClientCapabilities.SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(
        function* (target, expectedEnvironmentId) {
          const bridge = window.desktopBridge;
          if (bridge === undefined) {
            return yield* new ConnectionBlockedError({
              reason: "unsupported",
              detail: "SSH environments are only available in the desktop app.",
            });
          }
          return yield* provisionDesktopSshEnvironment(bridge, target, expectedEnvironmentId);
        },
      ),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* prepareDesktopSshEnvironment(bridge, input);
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        pendingSshSetups.delete(sshTargetKey(target));
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(ClientCapabilities.CloudSession, cloudSession).pipe(
      Context.add(ClientCapabilities.AnalyticsDevice, analyticsDevice),
      Context.add(ClientCapabilities.PrimaryEnvironmentAuth, primaryAuth),
      Context.add(ClientCapabilities.RelayDeviceIdentity, identity),
      Context.add(ClientCapabilities.ClientPresentation, presentation),
      Context.add(ClientCapabilities.SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(
    Effect.provide(PrimaryEnvironmentHttpLayer.layer),
    Effect.mapError(mapRemoteEnvironmentError),
  );
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

const loadSecondaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadSecondaryConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  if (
    entry.httpBaseUrl === null ||
    entry.wsBaseUrl === null ||
    entry.bootstrapToken === undefined
  ) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: `Desktop-local backend ${entry.id} is not ready yet.`,
    });
  }
  const httpBaseUrl = entry.httpBaseUrl;
  const wsBaseUrl = entry.wsBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const issuedAtEpochMs = yield* Clock.currentTimeMillis;
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: entry.bootstrapToken,
    scopes: AuthStandardClientScopes,
    clientMetadata: currentClientMetadata(),
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Desktop operations need the pool backend id to reach the owning instance; RPC uses the environment id.
  const connectionId = desktopLocalConnectionId(entry.id);
  const label = entry.label || descriptor.label;
  return {
    registration: new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({ token: access.access_token }),
    }),
    expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, access.expires_in),
    refreshAtEpochMs: secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, access.expires_in),
  };
});

// The bridge has no topology event, and every read is three synchronous IPC round trips
// (93% of the desktop trace at one read per 3 s). The tick below only decides whether a read is
// due; a settled topology is read every 30 s and otherwise on wakeups or when a bearer or a
// rejected-bootstrap retry comes due. An unsettled one (backend still starting) keeps the 3 s pace.
const PLATFORM_TICK_INTERVAL = "3 seconds";
const PLATFORM_SETTLED_READ_INTERVAL_MS = 30_000;
const SECONDARY_BEARER_REFRESH_SKEW_MS = 5_000;

export function nextPlatformTopologyReadAtEpochMs(input: {
  readonly nowEpochMs: number;
  readonly settled: boolean;
  readonly refreshAtEpochMs: ReadonlyArray<number>;
  readonly retryAtEpochMs: ReadonlyArray<number>;
}): number {
  if (!input.settled) return input.nowEpochMs;
  return Math.min(
    input.nowEpochMs + PLATFORM_SETTLED_READ_INTERVAL_MS,
    ...input.refreshAtEpochMs,
    ...input.retryAtEpochMs,
  );
}

const platformTopologyWakes = Stream.callback<"wake">((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const wake = () => Queue.offerUnsafe(queue, "wake");
      const onVisibility = () => {
        if (document.visibilityState === "visible") wake();
      };
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener(DESKTOP_TOPOLOGY_CHANGED_EVENT, wake);
      return { wake, onVisibility };
    }),
    ({ wake, onVisibility }) =>
      Effect.sync(() => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener(DESKTOP_TOPOLOGY_CHANGED_EVENT, wake);
      }),
  ).pipe(Effect.asVoid),
);

function secondaryBearerExpiresAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return issuedAtEpochMs + Math.max(0, expiresInSeconds * 1_000);
}

function secondaryBearerRefreshAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return Math.max(
    issuedAtEpochMs,
    secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, expiresInSeconds) -
      SECONDARY_BEARER_REFRESH_SKEW_MS,
  );
}

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
  readonly refreshAtEpochMs?: number;
  readonly bootstrapToken?: string;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function canReuseCachedPlatformRegistration(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    (cached.refreshAtEpochMs === undefined || nowEpochMs < cached.refreshAtEpochMs)
  );
}

export function canRetainCachedPlatformRegistrationAfterRefreshFailure(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    cached.expiresAtEpochMs !== undefined &&
    nowEpochMs < cached.expiresAtEpochMs
  );
}

const REJECTED_BOOTSTRAP_RETRY_INITIAL_MS = 60_000;
const REJECTED_BOOTSTRAP_RETRY_MAX_MS = 30 * 60_000;

export interface RejectedSecondaryBootstrap {
  readonly signature: string;
  readonly retryAtEpochMs: number;
  readonly delayMs: number;
}

/** Retry with backoff: a backend can restart on the same port with a fresh grant and no topology change. */
export function isRejectedSecondaryBootstrap(
  rejected: RejectedSecondaryBootstrap | undefined,
  signature: string,
  nowEpochMs: number,
): rejected is RejectedSecondaryBootstrap {
  return (
    rejected !== undefined &&
    rejected.signature === signature &&
    nowEpochMs < rejected.retryAtEpochMs
  );
}

export function nextRejectedSecondaryBootstrap(
  previous: RejectedSecondaryBootstrap | undefined,
  signature: string,
  nowEpochMs: number,
): RejectedSecondaryBootstrap {
  const delayMs =
    previous?.signature === signature
      ? Math.min(previous.delayMs * 2, REJECTED_BOOTSTRAP_RETRY_MAX_MS)
      : REJECTED_BOOTSTRAP_RETRY_INITIAL_MS;
  return { signature, retryAtEpochMs: nowEpochMs + delayMs, delayMs };
}

export function isRejectedBootstrapCredentialError(error: ConnectionAttemptError): boolean {
  return error._tag === "ConnectionBlockedError" && error.reason === "authentication";
}

export function secondaryRegistrationsToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: DesktopSecondaryBootstrapsRead,
  nowEpochMs: number,
): ReadonlyMap<string, CachedPlatformRegistration> {
  if (topologyRead._tag === "Success") {
    return new Map();
  }
  return new Map(
    [...previous].filter(
      ([, cached]) => cached.expiresAtEpochMs !== undefined && nowEpochMs < cached.expiresAtEpochMs,
    ),
  );
}

const layerPlatformConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp() || isLocalEnvironmentDisabled()) {
      return PlatformConnectionSource.PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());
    const rejectedRef = yield* Ref.make(new Map<string, RejectedSecondaryBootstrap>());
    const scheduleRef = yield* Ref.make<
      | {
          readonly nextReadAtEpochMs: number;
          readonly registrations: ReadonlyArray<PlatformConnectionRegistration>;
        }
      | undefined
    >(undefined);

    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];
      let settled = true;
      let rejectedRetryAtEpochMs: ReadonlyArray<number> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        settled = false;
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target === null) {
        // On desktop a missing primary means its backend has not published a config yet.
        if (window.desktopBridge !== undefined) settled = false;
      } else {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (
          cached !== undefined &&
          canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
        ) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          } else {
            settled = false;
          }
        }
      }

      const topologyRead = readDesktopSecondaryBootstrapsResult();
      for (const [id, cached] of secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        topologyRead,
        nowEpochMs,
      )) {
        next.set(id, cached);
        registrations.push(cached.registration);
      }

      if (topologyRead._tag === "Failure") {
        settled = false;
        yield* Effect.logWarning("Could not read the desktop-local backend topology.", {
          cause: topologyRead.cause,
        });
      } else {
        const rejected = yield* Ref.get(rejectedRef);
        const nextRejected = new Map<string, RejectedSecondaryBootstrap>();
        for (const bootstrap of topologyRead.bootstraps) {
          // Token rotation only controls exchange retries; dropping endpoint bearers also clears drafts.
          const endpointSignature = `${bootstrap.httpBaseUrl}|${bootstrap.wsBaseUrl}`;
          const signature = `${endpointSignature}|${bootstrap.bootstrapToken ?? ""}`;
          const cached = previous.get(bootstrap.id);
          // Rotation may mean a restart; retain the old bearer if the new exchange fails.
          if (
            cached !== undefined &&
            cached.bootstrapToken === bootstrap.bootstrapToken &&
            canReuseCachedPlatformRegistration(cached, endpointSignature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
            continue;
          }
          const previouslyRejected = rejected.get(bootstrap.id);
          if (isRejectedSecondaryBootstrap(previouslyRejected, signature, nowEpochMs)) {
            nextRejected.set(bootstrap.id, previouslyRejected);
            if (
              cached !== undefined &&
              canRetainCachedPlatformRegistrationAfterRefreshFailure(
                cached,
                endpointSignature,
                nowEpochMs,
              )
            ) {
              next.set(bootstrap.id, cached);
              registrations.push(cached.registration);
            }
            continue;
          }
          const built = yield* loadSecondaryConnectionRegistration(bootstrap).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not connect a desktop-local backend.", {
                id: bootstrap.id,
                error,
              }),
            ),
            Effect.tapError((error) =>
              isRejectedBootstrapCredentialError(error)
                ? // Start backoff at rejection; this poll can outlast the first delay.
                  Clock.currentTimeMillis.pipe(
                    Effect.map((rejectedAtEpochMs) =>
                      nextRejected.set(
                        bootstrap.id,
                        nextRejectedSecondaryBootstrap(
                          previouslyRejected,
                          signature,
                          rejectedAtEpochMs,
                        ),
                      ),
                    ),
                  )
                : Effect.void,
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = {
              signature: endpointSignature,
              ...(bootstrap.bootstrapToken === undefined
                ? {}
                : { bootstrapToken: bootstrap.bootstrapToken }),
              ...built.value,
            };
            next.set(bootstrap.id, cacheEntry);
            registrations.push(built.value.registration);
          } else {
            // A rejected credential waits on its own retry time; anything else may clear soon.
            if (!nextRejected.has(bootstrap.id)) settled = false;
            if (
              cached !== undefined &&
              canRetainCachedPlatformRegistrationAfterRefreshFailure(
                cached,
                endpointSignature,
                nowEpochMs,
              )
            ) {
              next.set(bootstrap.id, cached);
              registrations.push(cached.registration);
            }
          }
        }
        yield* Ref.set(rejectedRef, nextRejected);
        rejectedRetryAtEpochMs = [...nextRejected.values()].map((entry) => entry.retryAtEpochMs);
      }

      yield* Ref.set(cacheRef, next);
      const builtRegistrations: ReadonlyArray<PlatformConnectionRegistration> = registrations;
      yield* Ref.set(scheduleRef, {
        nextReadAtEpochMs: nextPlatformTopologyReadAtEpochMs({
          nowEpochMs: yield* Clock.currentTimeMillis,
          settled,
          refreshAtEpochMs: [...next.values()].flatMap((entry) =>
            entry.refreshAtEpochMs === undefined ? [] : [entry.refreshAtEpochMs],
          ),
          retryAtEpochMs: rejectedRetryAtEpochMs,
        }),
        registrations: builtRegistrations,
      });
      return builtRegistrations;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    // Untraced: this runs on every 3 s tick and almost always just returns the cached list.
    const registrationsWhenDue = Effect.fnUntraced(function* (wake: boolean) {
      const schedule = yield* Ref.get(scheduleRef);
      if (!wake && schedule !== undefined) {
        const nowEpochMs = yield* Clock.currentTimeMillis;
        if (nowEpochMs < schedule.nextReadAtEpochMs) return schedule.registrations;
      }
      return yield* buildPlatformRegistrations;
    });

    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.mergeAll(
        [
          Stream.tick(PLATFORM_TICK_INTERVAL).pipe(Stream.map(() => false)),
          platformTopologyWakes.pipe(Stream.map(() => true)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.mapEffect(registrationsWhenDue)),
    });
  }),
);

const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: Effect.fn("Persistence.EnvironmentOwnedDataCleanup.clear")(function (environmentId) {
      return Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      });
    }),
  }),
);

const layerRpcRequestObserver = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    // Every RPC passes through this observer; the request owns its span.
    observe: Effect.fnUntraced(function* ({ environmentId, environmentLabel, method }) {
      return yield* Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentLabel}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      });
    }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof ConnectionStorage.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerCapabilities
  | typeof layerPlatformConnectionSource
  | typeof layerEnvironmentOwnedDataCleanup
  | typeof layerRpcRequestObserver;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  ConnectionStorage.layer,
  layerConnectivity,
  layerWakeups,
  layerCapabilities,
  layerPlatformConnectionSource,
  layerEnvironmentOwnedDataCleanup,
  layerRpcRequestObserver,
);
