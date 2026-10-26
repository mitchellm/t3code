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
  type ProjectId,
  SOLO_LOADOUT_ID,
  ThreadId,
} from "@t3tools/contracts";
import { providerSupportsCompaction } from "@t3tools/shared/buildModes";
import { summarizeLoadoutRoles } from "@t3tools/shared/loadoutSummary";
import { loadoutDelegationTarget, resolveLoadout, withSolo } from "@t3tools/shared/loadouts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
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
const AUDIT_THREAD_PREFIX = "thread:audit:";
/** Server ids under the reserved `command:mcp:` prefix, so no client can claim them first. */
const commandKey = (id: string) => `command:mcp:build-mode:${id}`;

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
    /**
     * Starts the loadout's judge on the plan and returns at once; its findings join the ledger as
     * items when it finishes.
     */
    readonly audit: BuildModeMethod;
    /** Archives audit threads a restart left with nothing to finish them. Returns how many. */
    readonly sweep: () => Effect.Effect<number, OrchestrationBuildModeError>;
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

  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);

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

  /**
   * Dispatches in order: the mode change before the build turn that reads it, the compact before
   * the build queued behind it. The mode change and the build stand or fall together: if a later
   * command fails, the thread goes back to plan mode rather than sitting out of it with no build.
   */
  const dispatchBuild = Effect.fn("BuildModeService.dispatchBuild")(function* (
    threadId: ThreadId,
    key: string,
    commands: ReadonlyArray<OrchestrationV2ServerCommand>,
  ) {
    const leftPlanMode = commands[0]?.type === "thread.interaction-mode.set";
    for (const command of commands) {
      const exit = yield* Effect.exit(threads.dispatch(command));
      if (Exit.isSuccess(exit)) continue;
      if (leftPlanMode && command !== commands[0]) {
        yield* threads
          .dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(`${key}:mode-restore`),
            threadId,
            interactionMode: "plan",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not restore plan mode after a failed build", {
                threadId,
                cause,
              }),
            ),
          );
      }
      return yield* failed("The build could not be started.")(Cause.squash(exit.cause));
    }
  });

  const runBuild = (action: "build" | "compact_and_build" | "reset_and_build") =>
    Effect.fn(`BuildModeService.${action}`)(function* (input: BuildModeRequest) {
      yield* Effect.annotateCurrentSpan({ threadId: input.threadId, action });
      const { records, subject, loadout } = yield* readSubject(input.threadId, action);
      const key = commandKey(yield* newId);
      yield* dispatchBuild(
        input.threadId,
        key,
        buildCommands({
          action,
          threadId: input.threadId,
          key,
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

  // Audits run past the request that started them; the set ends them with the service.
  const audits = yield* FiberSet.make();
  // Audit threads this process is still running, so a sweep never archives a live one.
  const auditsInFlight = new Set<ThreadId>();

  const runAudit = Effect.fn("BuildModeService.runAudit")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly auditThreadId: ThreadId;
    readonly key: string;
    readonly model: ModelSelection;
    readonly prompt: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { key, auditThreadId, projectId } = input;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(`${key}:audit-create`),
      threadId: auditThreadId,
      projectId,
      title: "Plan audit",
      modelSelection: input.model,
      // As with the retro: a server-created thread cannot auto-deny, so anything that would
      // change the workspace waits on an approval nobody gives and the timeout ends it.
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: input.branch,
      worktreePath: input.worktreePath,
      // A hidden subagent child of the thread it audits, so it stays out of the thread lists.
      lineage: { parentThreadId: input.threadId, relationshipToParent: "subagent" },
    });

    const answer = yield* Effect.gen(function* () {
      const sent = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`${key}:audit-send`),
        threadId: auditThreadId,
        messageId: MessageId.make(`${key}:audit-message`),
        text: input.prompt,
        attachments: [],
        modelSelection: input.model,
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      });
      const waited = yield* threads.waitForThread({
        projectId,
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
    }).pipe(Effect.ensuring(finishAuditThread(projectId, auditThreadId, key)));
    if (answer === null) {
      return yield* Effect.logWarning("The plan audit did not finish", {
        threadId: input.threadId,
      });
    }

    // Read again: the ledger may have closed or been replaced while the judge worked.
    const { ledger } = yield* threads.getProjectThreadRecords(
      { projectId, threadId: input.threadId },
      ["ledger"],
    );
    for (const command of auditCommands({
      threadId: input.threadId,
      key,
      ledger,
      findings: parseAuditFindings(answer),
    })) {
      yield* threads.dispatch(command);
    }
  });

  const finishAuditThread = Effect.fn("BuildModeService.finishAuditThread")(function* (
    projectId: ProjectId,
    auditThreadId: ThreadId,
    key: string,
  ) {
    yield* threads
      .interruptThread({
        projectId,
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

  const audit: BuildModeMethod = Effect.fn("BuildModeService.audit")(function* (input) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId, action: "audit" });
    const { shell, records, subject, judge } = yield* readSubject(input.threadId, "audit");
    if (judge?.providerInstanceId === undefined || judge.model === undefined) {
      return yield* refused("The thread's loadout has no judge role.");
    }
    const { messages } = yield* threads
      .getThreadRecords(input.threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.mapError(failed("Could not read the thread.")));
    const requests = messages
      .filter((message) => message.createdBy === "user" && message.creationSource !== "server")
      .map((message) => message.text)
      .slice(-AUDIT_REQUEST_LIMIT);
    const id = yield* newId;
    const auditThreadId = ThreadId.make(`${AUDIT_THREAD_PREFIX}${id}`);
    auditsInFlight.add(auditThreadId);
    yield* FiberSet.run(
      audits,
      runAudit({
        threadId: input.threadId,
        projectId: shell.projectId,
        auditThreadId,
        key: commandKey(id),
        model: {
          instanceId: judge.providerInstanceId,
          model: judge.model,
          ...(judge.options === undefined ? {} : { options: judge.options }),
        },
        prompt: auditPrompt({ requests, plan: subject.plan, ledger: records.ledger }),
        branch: shell.branch,
        worktreePath: shell.worktreePath,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The plan audit failed", { threadId: input.threadId, cause }),
        ),
        Effect.ensuring(Effect.sync(() => auditsInFlight.delete(auditThreadId))),
      ),
    );
    return { action: "audit" };
  });

  const sweep: BuildModeService["Service"]["sweep"] = Effect.fn("BuildModeService.sweep")(
    function* () {
      const snapshot = yield* threads
        .getShellSnapshot()
        .pipe(Effect.mapError(failed("Could not read the threads.")));
      const orphans = snapshot.threads.filter(
        (thread) => thread.id.startsWith(AUDIT_THREAD_PREFIX) && !auditsInFlight.has(thread.id),
      );
      yield* Effect.forEach(
        orphans,
        (thread) =>
          finishAuditThread(
            thread.projectId,
            thread.id,
            `command:mcp:build-mode:sweep-${encodeURIComponent(thread.id)}`,
          ),
        { discard: true },
      );
      return orphans.length;
    },
  );

  return BuildModeService.of({
    build: runBuild("build"),
    compactAndBuild: runBuild("compact_and_build"),
    resetAndBuild: runBuild("reset_and_build"),
    audit,
    sweep,
  });
});

export const layer = Layer.effect(BuildModeService, make);
