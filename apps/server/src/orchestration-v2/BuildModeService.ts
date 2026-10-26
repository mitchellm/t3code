// Fork: Build, Compact and build, Reset and build, and Audit, the four ways out of plan mode (H5).
import {
  type BuildModeAction,
  CommandId,
  MessageId,
  type ModelSelection,
  OrchestrationBuildModeError,
  type OrchestrationV2ServerCommand,
  type OrchestrationRunBuildModeInput,
  type OrchestrationRunBuildModeResult,
  SOLO_LOADOUT_ID,
  ThreadId,
} from "@t3tools/contracts";
import { providerSupportsCompaction } from "@t3tools/shared/buildModes";
import { summarizeLoadoutRoles } from "@t3tools/shared/loadoutSummary";
import { loadoutDelegationTarget, resolveLoadout, withSolo } from "@t3tools/shared/loadouts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  auditCommands,
  auditPrompt,
  buildCommands,
  buildModeRefusal,
  buildSubject,
  parseAuditFindings,
} from "./BuildMode.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** An audit reads the repository against the plan; past this it is stuck, likely on an approval. */
const AUDIT_TIMEOUT_MS = 10 * 60 * 1_000;
/** The newest requests carry the intent; older ones are usually superseded. */
const AUDIT_REQUEST_LIMIT = 5;

type BuildModeRequest = Omit<OrchestrationRunBuildModeInput, "action">;
type BuildModeMethod = (
  input: BuildModeRequest,
) => Effect.Effect<OrchestrationRunBuildModeResult, OrchestrationBuildModeError>;

export class BuildModeService extends Context.Service<
  BuildModeService,
  {
    /** Leaves plan mode and implements the plan, or builds the planning ledger, in this context. */
    readonly build: BuildModeMethod;
    /** Compacts the provider's context with a `/compact` turn, then builds behind it. */
    readonly compactAndBuild: BuildModeMethod;
    /** Builds in a new native conversation seeded with the ledger and loadout. */
    readonly resetAndBuild: BuildModeMethod;
    /** Has the loadout's judge review the plan; its findings join the ledger as items. */
    readonly audit: BuildModeMethod;
  }
>()("t3/orchestration-v2/BuildModeService") {}

/** The transport's way in: one action name to one method. */
export const buildModeMethod = (
  service: BuildModeService["Service"],
  action: BuildModeAction,
): BuildModeMethod => {
  switch (action) {
    case "build":
      return service.build;
    case "compact_and_build":
      return service.compactAndBuild;
    case "reset_and_build":
      return service.resetAndBuild;
    case "audit":
      return service.audit;
  }
};

const refused = (message: string) => new OrchestrationBuildModeError({ message });
const failed = (message: string) => (cause: unknown) =>
  new OrchestrationBuildModeError({ message, cause });

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const crypto = yield* Crypto.Crypto;

  const newKey = crypto.randomUUIDv4().pipe(
    Effect.map((id) => `command:mcp:build-mode:${id}`),
    Effect.orDie,
  );

  const readSubject = Effect.fn("BuildModeService.readSubject")(function* (
    threadId: ThreadId,
    action: BuildModeAction,
  ) {
    const readFailed = failed("Could not read the thread.");
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(readFailed));
    if (shell === null || shell.deletedAt !== null) return yield* refused("Thread not found.");
    const records = yield* threads
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
        "plans",
        "ledger",
        "runs",
      ])
      .pipe(Effect.mapError(readFailed));
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(failed("Could not read settings.")),
    );
    const providers = yield* providerRegistry.getProviders;
    const loadout = resolveLoadout(
      withSolo(resolveProjectSettings(settings, shell.projectId).settings.loadouts),
      shell.loadout?.id,
    );
    const judge = loadoutDelegationTarget(loadout, "judge", providers);
    const provider = providers.find(
      (candidate) => candidate.instanceId === records.thread.providerInstanceId,
    );
    const subject = buildSubject({
      interactionMode: records.thread.interactionMode,
      plans: records.plans,
      ledger: records.ledger,
      runs: records.runs,
      compactSupported: providerSupportsCompaction(provider?.slashCommands ?? []),
      judgeConfigured: judge?.providerInstanceId !== undefined && judge.model !== undefined,
    });
    const refusal = buildModeRefusal(subject, action);
    if (refusal !== null) return yield* refused(refusal);
    return { shell, records, subject, loadout, judge };
  });

  const dispatchAll = Effect.fn("BuildModeService.dispatchAll")(function* (
    commands: ReadonlyArray<OrchestrationV2ServerCommand>,
  ) {
    // In order: the mode change lands before the build turn reads it, the compact before the
    // build that queues behind it.
    for (const command of commands) {
      yield* threads
        .dispatch(command)
        .pipe(Effect.mapError(failed("The build could not be started.")));
    }
  });

  const runBuild = (action: "build" | "compact_and_build" | "reset_and_build") =>
    Effect.fn(`BuildModeService.${action}`)(function* (input: BuildModeRequest) {
      yield* Effect.annotateCurrentSpan({ threadId: input.threadId, action });
      const { records, subject, loadout } = yield* readSubject(input.threadId, action);
      yield* dispatchAll(
        buildCommands({
          action,
          threadId: input.threadId,
          key: yield* newKey,
          interactionMode: records.thread.interactionMode,
          plan: subject.plan,
          ledger: records.ledger,
          loadout:
            loadout.id === SOLO_LOADOUT_ID
              ? null
              : { name: loadout.name, roles: summarizeLoadoutRoles(loadout) },
          creationSource: input.creationSource,
        }),
      );
      return { action };
    });

  const audit: BuildModeMethod = Effect.fn("BuildModeService.audit")(function* (input) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId, action: "audit" });
    const { shell, records, subject, judge } = yield* readSubject(input.threadId, "audit");
    if (judge?.providerInstanceId === undefined || judge.model === undefined) {
      return yield* refused("The thread's loadout has no judge role.");
    }
    const model: ModelSelection = {
      instanceId: judge.providerInstanceId,
      model: judge.model,
      ...(judge.options === undefined ? {} : { options: judge.options }),
    };
    const { messages } = yield* threads
      .getThreadRecords(input.threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.mapError(failed("Could not read the thread.")));
    const requests = messages
      .filter((message) => message.createdBy === "user" && message.creationSource !== "server")
      .map((message) => message.text)
      .slice(-AUDIT_REQUEST_LIMIT);
    const key = yield* newKey;
    const auditThreadId = ThreadId.make(`thread:${key}`);
    const runFailed = failed("The audit did not finish.");

    yield* threads
      .dispatch({
        type: "thread.create",
        createdBy: "system",
        creationSource: "server",
        commandId: CommandId.make(`${key}:audit-create`),
        threadId: auditThreadId,
        projectId: shell.projectId,
        title: "Plan audit",
        modelSelection: model,
        // As with the retro: a server-created thread cannot auto-deny, so anything that would
        // change the workspace waits on an approval nobody gives and the timeout ends it.
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: shell.branch,
        worktreePath: shell.worktreePath,
        // A hidden subagent child of the thread it audits, so it stays out of the thread lists.
        lineage: { parentThreadId: input.threadId, relationshipToParent: "subagent" },
      })
      .pipe(Effect.mapError(runFailed));

    const finish = Effect.gen(function* () {
      yield* threads
        .interruptThread({
          projectId: shell.projectId,
          commandId: CommandId.make(`${key}:audit-interrupt`),
          threadId: auditThreadId,
          reason: "The audit ended.",
        })
        .pipe(Effect.ignore);
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`${key}:audit-archive`),
          threadId: auditThreadId,
        })
        .pipe(Effect.ignore);
    });

    const answer = yield* Effect.gen(function* () {
      const sent = yield* threads.sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`${key}:audit-send`),
        threadId: auditThreadId,
        messageId: MessageId.make(`${key}:audit-message`),
        text: auditPrompt({ requests, plan: subject.plan, ledger: records.ledger }),
        attachments: [],
        modelSelection: model,
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      });
      const waited = yield* threads.waitForThread({
        projectId: shell.projectId,
        threadId: auditThreadId,
        runId: sent.run.id,
        timeoutMs: AUDIT_TIMEOUT_MS,
      });
      if (waited.run?.status !== "completed") return null;
      const { messages: replies } = yield* threads.getThreadRecords(auditThreadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [waited.run.id],
      });
      return replies.at(-1)?.text ?? null;
    }).pipe(Effect.mapError(runFailed), Effect.ensuring(finish));
    if (answer === null) return yield* refused("The audit did not finish.");

    const findings = parseAuditFindings(answer);
    yield* dispatchAll(
      auditCommands({ threadId: input.threadId, key, ledger: records.ledger, findings }),
    );
    return { action: "audit", findings: findings.length };
  });

  return BuildModeService.of({
    build: runBuild("build"),
    compactAndBuild: runBuild("compact_and_build"),
    resetAndBuild: runBuild("reset_and_build"),
    audit,
  });
});

export const layer = Layer.effect(BuildModeService, make);
