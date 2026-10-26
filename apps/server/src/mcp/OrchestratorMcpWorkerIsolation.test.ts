import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const codex = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:worker-isolation");
const projectId = ProjectId.make("project:worker-isolation");
const runId = RunId.make("run:worker-isolation");
const rootNodeId = NodeId.make("node:worker-isolation");
const commitSha = "a".repeat(40);
let requestCounter = 0;

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:worker-isolation"),
  requestNamespace: "provider-session:worker-isolation",
  thread: {
    threadId,
    providerSessionId: "provider-session:worker-isolation",
    providerInstanceId: codex,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const snapshot: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-26T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const role = { instanceId: codex, model: "gpt-5.4" };
const loadouts = [
  {
    id: "org",
    name: "Org",
    description: "Every role assigned.",
    roles: { subPlanner: role, explorer: role, worker: role, judge: role },
  },
  { id: "explorers-only", name: "Explorers", description: "No worker.", roles: { explorer: role } },
];

const parentProjection = (loadoutId: string | null, worktreePath: string | null = null) =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "Parent",
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath,
      loadout: loadoutId === null ? null : { id: loadoutId, reason: null, setBy: "user" },
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        status: "running",
        rootNodeId,
        providerInstanceId: codex,
        modelSelection: { instanceId: codex, model: "gpt-5.4" },
      },
    ],
    contextTransfers: [],
    subagents: [],
  }) as unknown as OrchestrationV2ThreadProjection;

type Delegation = {
  readonly role?: "worker" | "subPlanner" | "explorer" | "judge" | "review";
  readonly isolation?: "shared" | "worktree" | "none";
  readonly target?: { readonly providerInstanceId: ProviderInstanceId };
};

/**
 * Runs one delegate_task and returns the command the service handed to thread management, or
 * undefined when it failed first. The dispatch is refused after capture so no child run is needed.
 */
const delegate = (options: {
  readonly loadoutId: string | null;
  readonly delegation: Delegation;
  readonly isGitRepo?: boolean;
  readonly parentWorktreePath?: string | null;
}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const isGitRepo = options.isGitRepo ?? true;
    const layerDependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        hasReceipt: () => Effect.succeed(false),
        getThreadRecords: () =>
          Effect.succeed(parentProjection(options.loadoutId, options.parentWorktreePath ?? null)),
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.andThen(
              Effect.fail({ _tag: "Refused", message: "stop after capture" } as never),
            ),
          ),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([snapshot]),
        refreshInstance: () => Effect.succeed([snapshot]),
      }),
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([codex]),
          get: (instanceId) =>
            Effect.succeed({
              instanceId,
            } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
        }),
      ),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Project",
            workspaceRoot: "/repo",
          } as never),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ServerSettings.layerTest({ loadouts }),
    );
    const layerService = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({ prepareRun: () => Effect.void }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: () =>
            isGitRepo
              ? Effect.succeed({ commitSha })
              : Effect.fail({ _tag: "GitCommandError", message: "not a git repository" } as never),
        }),
      ),
      Layer.provide(layerDependencies),
    );
    const exit = yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service
        .delegateTask(scope, {
          task: "Implement the module.",
          mode: "async",
          clientRequestId: `isolation-${requestCounter++}`,
          ...options.delegation,
        })
        .pipe(Effect.exit);
    }).pipe(Effect.provide(layerService));
    const [command] = (yield* Ref.get(dispatched)) as ReadonlyArray<{
      readonly workspaceStrategy?: unknown;
    }>;
    return { command, exit };
  });

const isolatedStrategy = { type: "worktree", baseRef: commitSha, startFromOrigin: false };

describe("delegate_task default isolation", () => {
  it.effect("puts a worker in its own worktree when the loadout assigns workers", () =>
    Effect.gen(function* () {
      const { command } = yield* delegate({ loadoutId: "org", delegation: { role: "worker" } });
      assert.deepEqual(command?.workspaceStrategy, isolatedStrategy);
    }),
  );

  it.effect("puts a sub-planner in its own worktree", () =>
    Effect.gen(function* () {
      const { command } = yield* delegate({ loadoutId: "org", delegation: { role: "subPlanner" } });
      assert.deepEqual(command?.workspaceStrategy, isolatedStrategy);
    }),
  );

  it.effect("keeps isolating a worker that names an explicit target", () =>
    Effect.gen(function* () {
      const { command } = yield* delegate({
        loadoutId: "org",
        delegation: { role: "worker", target: { providerInstanceId: codex } },
      });
      assert.deepEqual(command?.workspaceStrategy, isolatedStrategy);
    }),
  );

  it.effect("isolation none and shared both opt a worker out", () =>
    Effect.gen(function* () {
      for (const isolation of ["none", "shared"] as const) {
        const { command } = yield* delegate({
          loadoutId: "org",
          delegation: { role: "worker", isolation },
        });
        assert.isDefined(command);
        assert.isUndefined(command?.workspaceStrategy);
      }
    }),
  );

  it.effect("leaves read-only roles in the shared checkout", () =>
    Effect.gen(function* () {
      for (const delegation of [{ role: "explorer" }, { role: "judge" }, {}] as const) {
        const { command } = yield* delegate({ loadoutId: "org", delegation });
        assert.isDefined(command);
        assert.isUndefined(command?.workspaceStrategy);
      }
    }),
  );

  it.effect("does not isolate a role the thread's loadout does not assign", () =>
    Effect.gen(function* () {
      for (const loadoutId of ["explorers-only", null]) {
        const { command } = yield* delegate({ loadoutId, delegation: { role: "worker" } });
        assert.isDefined(command);
        assert.isUndefined(command?.workspaceStrategy);
      }
    }),
  );

  it.effect("falls back to the shared checkout, silently, outside a git repository", () =>
    Effect.gen(function* () {
      const { command, exit } = yield* delegate({
        loadoutId: "org",
        delegation: { role: "worker" },
        isGitRepo: false,
      });
      assert.isDefined(command);
      assert.isUndefined(command?.workspaceStrategy);
      // The only failure is the refused test dispatch, never an isolation error.
      assert.include(JSON.stringify(exit), "Unable to create delegated task");
    }),
  );

  it.effect("still rejects an explicit worktree request outside a git repository", () =>
    Effect.gen(function* () {
      const { command, exit } = yield* delegate({
        loadoutId: "org",
        delegation: { role: "worker", isolation: "worktree" },
        isGitRepo: false,
      });
      assert.isUndefined(command);
      assert.include(JSON.stringify(exit), "Unable to resolve the parent checkout commit");
    }),
  );
});
