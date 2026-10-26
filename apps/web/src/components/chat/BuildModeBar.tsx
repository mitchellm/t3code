// Fork: Build / Compact and build / Reset and build / Audit, on the active plan card and under a
// ledger made while planning. The server decides; this shows only what it would accept.
import { useAtomValue } from "@effect/atom-react";
import type { BuildModeAction, ScopedThreadRef } from "@t3tools/contracts";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { deriveLedgerProgress } from "@t3tools/client-runtime/state/thread-ledger";
import { buildModeAvailability, providerSupportsCompaction } from "@t3tools/shared/buildModes";
import { loadoutHasJudge } from "@t3tools/shared/loadouts";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { useThreadLedgerIfSupported } from "~/hooks/useThreadLedgerIfSupported";
import { useEnvironmentProviders } from "~/state/environments";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useComposerLoadout } from "./useComposerLoadout";

const ACTIONS: ReadonlyArray<{
  readonly action: BuildModeAction;
  readonly label: string;
  readonly busyLabel: string;
}> = [
  { action: "build", label: "Build", busyLabel: "Starting…" },
  { action: "compact_and_build", label: "Compact and build", busyLabel: "Starting…" },
  { action: "reset_and_build", label: "Reset and build", busyLabel: "Starting…" },
  { action: "audit", label: "Audit", busyLabel: "Auditing…" },
];

export function BuildModeBar({
  threadRef,
  className,
}: {
  threadRef: ScopedThreadRef;
  /** Spacing from its surroundings; the bar renders nothing at all when no action is offered. */
  className?: string;
}) {
  const { environmentId } = threadRef;
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.buildModes === true;
  const shell = useThreadShell(threadRef);
  const ledger = useThreadLedgerIfSupported(threadRef);
  const loadout = useComposerLoadout(environmentId, threadRef);
  const providers = useEnvironmentProviders().get(environmentId);
  const runBuildMode = useAtomCommand(orchestrationEnvironment.runBuildMode, {
    reportFailure: false,
  });
  const canRun = useAtomValue(orchestrationEnvironment.runBuildMode.permissionAtom(environmentId));
  const setDraftInteractionMode = useComposerDraftStore((store) => store.setInteractionMode);
  const [running, setRunning] = useState<BuildModeAction | null>(null);

  if (!supported || shell === null || threadRuntimeIsActive(shell.runtime)) return null;
  const provider = providers?.find((entry) => entry.instanceId === shell.providerInstanceId);
  const planningLedger =
    shell.interactionMode === "plan" && ledger !== null && deriveLedgerProgress(ledger).active;
  const availability = buildModeAvailability({
    hasWork: shell.hasActionableProposedPlan || planningLedger,
    compactSupported: providerSupportsCompaction(provider?.slashCommands ?? []),
    judgeConfigured: loadout !== null && loadoutHasJudge(loadout.active),
  });
  const offered = ACTIONS.filter(({ action }) => availability[action] === null);
  if (offered.length === 0) return null;

  const run = async (action: BuildModeAction) => {
    setRunning(action);
    const result = await runBuildMode({
      environmentId,
      input: { threadId: threadRef.threadId, action, creationSource: "web" },
    });
    setRunning(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: action === "audit" ? "The audit did not finish" : "Could not start the build",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    if (action === "audit") {
      const findings = result.value.findings ?? 0;
      toastManager.add({
        type: "success",
        title: findings === 0 ? "Audit found nothing to fix" : "Audit added findings",
        ...(findings === 0
          ? {}
          : { description: `${findings} item${findings === 1 ? "" : "s"} added to the ledger.` }),
      });
      return;
    }
    // The server left plan mode; the draft would otherwise put the next send back into it.
    setDraftInteractionMode(threadRef, "default");
  };

  return (
    <div data-build-mode-bar className={cn("flex flex-wrap items-center gap-2", className)}>
      {offered.map(({ action, label, busyLabel }) => (
        <Button
          key={action}
          size="sm"
          variant={action === "build" ? "default" : "outline"}
          disabled={!canRun || running !== null}
          onClick={() => void run(action)}
        >
          {running === action ? busyLabel : label}
        </Button>
      ))}
    </div>
  );
}
