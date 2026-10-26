/** Fork: Investigate mode's run view, shown above the task ledger it runs on. */
import { useAtomValue } from "@effect/atom-react";
import type { Ledger, LedgerInvestigation, ScopedThreadRef } from "@t3tools/contracts";
import {
  type ApproachLaneStatus,
  formatInvestigationBudget,
  investigationBudgetUse,
  investigationLanes,
} from "@t3tools/shared/investigation";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const STATUS_PRESENTATION: Record<
  LedgerInvestigation["status"],
  { readonly label: string; readonly badge: "info" | "success" | "warning" | "secondary" }
> = {
  running: { label: "Running", badge: "info" },
  solved: { label: "Solved", badge: "success" },
  exhausted: { label: "Out of budget", badge: "warning" },
  stopped: { label: "Stopped", badge: "secondary" },
};

const LANE_PRESENTATION: Record<
  ApproachLaneStatus,
  {
    readonly label: string;
    readonly badge: "outline" | "warning" | "error" | "success" | "secondary";
  }
> = {
  exploring: { label: "Exploring", badge: "outline" },
  judging: { label: "Thesis, judging", badge: "warning" },
  refuted: { label: "Refuted", badge: "error" },
  passed: { label: "Passed", badge: "success" },
  dropped: { label: "Stopped", badge: "secondary" },
};

const minutes = (ms: number) => Math.floor(ms / 60_000);

function BudgetLine({ investigation }: { investigation: LedgerInvestigation }) {
  // A UTC minute stamp ("YYYY-MM-DDTHH:MM"): elapsed time shows whole minutes, so it re-renders
  // once a minute and nothing animates.
  const nowMinute = useNowMinute();
  const use = investigationBudgetUse({
    investigation,
    nowMs: Date.parse(`${nowMinute}:00.000Z`),
    spentUsd: 0,
  });
  const elapsed = `${minutes(use.elapsedMs)} min elapsed`;
  const limits = formatInvestigationBudget(investigation);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs tabular-nums text-muted-foreground">
        {elapsed} of {limits}
        {investigation.budget.usd === undefined ? "" : ". Spend is checked as turns finish"}
      </p>
      {use.limitMs === null ? null : (
        <div
          role="progressbar"
          aria-label="Time budget used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(use.fraction * 100)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={use.fraction >= 1 ? "h-full bg-warning" : "h-full bg-info"}
            style={{ width: `${Math.round(use.fraction * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function InvestigationPanel({
  threadRef,
  ledger,
}: {
  threadRef: ScopedThreadRef;
  ledger: Ledger;
}) {
  const stopInvestigation = useAtomCommand(orchestrationEnvironment.stopInvestigation, {
    reportFailure: false,
  });
  const canStop = useAtomValue(
    orchestrationEnvironment.stopInvestigation.permissionAtom(threadRef.environmentId),
  );
  const [stopping, setStopping] = useState(false);
  const investigation = ledger.investigation;
  if (investigation === undefined) return null;
  const status = STATUS_PRESENTATION[investigation.status];
  const lanes = investigationLanes(ledger);

  const stopAll = async () => {
    setStopping(true);
    const result = await stopInvestigation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setStopping(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not stop the investigation",
        description: formatEnvironmentQueryError(result.cause),
      });
    }
  };

  return (
    <div data-investigation-panel className="flex flex-col gap-3 px-2.5 py-1">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words text-sm font-medium text-foreground/80">Investigation</p>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={status.badge} size="sm">
            {status.label}
          </Badge>
          {investigation.status === "running" ? (
            <Button
              size="compact"
              variant="outline"
              disabled={!canStop || stopping}
              onClick={stopAll}
            >
              {stopping ? "Stopping…" : "Stop all"}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="line-clamp-3 break-words text-2xs text-muted-foreground">
        Solved when: {investigation.solvedWhen}
      </p>
      <BudgetLine investigation={investigation} />
      {investigation.endReason === undefined ? null : (
        <p className="break-words text-2xs text-muted-foreground">{investigation.endReason}</p>
      )}
      {lanes.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          {investigation.status === "running"
            ? `Waiting for the planner to propose up to ${investigation.parallelApproaches} approaches.`
            : "No approaches were proposed."}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {lanes.map((lane) => (
            <li key={lane.item.id} className="flex items-start gap-2">
              <span className="min-w-0 flex-1 break-words text-xs text-foreground/80">
                {lane.item.title}
              </span>
              <Badge variant={LANE_PRESENTATION[lane.status].badge} size="sm">
                {LANE_PRESENTATION[lane.status].label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
