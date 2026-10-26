// Fork: the Overview screen, one row per active thread.
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadOverviewRows,
  ledgerBarFraction,
  type OverviewNow,
  type ThreadOverviewRow,
} from "@t3tools/client-runtime/state/thread-overview";
import { SOLO_LOADOUT_ID } from "@t3tools/contracts";
import { resolveLoadout, withSolo } from "@t3tools/shared/loadouts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const NOW_LABELS: Record<OverviewNow, string> = {
  waiting: "Waiting on you",
  judging: "Judging",
  running: "Running",
  idle: "Idle",
};

const NOW_VARIANTS: Record<OverviewNow, "warning" | "info" | "success" | "outline"> = {
  waiting: "warning",
  judging: "info",
  running: "success",
  idle: "outline",
};

/** The dash means exactly one thing: no ledger, or one with nothing to measure. */
function LedgerCell({ ledger }: { ledger: ThreadOverviewRow["ledger"] }) {
  if (ledger === null) return <span className="text-muted-foreground">-</span>;
  return (
    <div className="flex items-center gap-2">
      <span className="tabular-nums">
        {ledger.closed}/{ledger.total}
      </span>
      <div className="h-1 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full bg-primary"
          style={{ width: `${Math.round(ledgerBarFraction(ledger) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function useLoadoutName(row: ThreadOverviewRow): string {
  const project = useProject(scopeProjectRef(row.environmentId, row.projectId));
  const settings = useEnvironmentSettings(row.environmentId);
  if (row.loadoutId === null || row.loadoutId === SOLO_LOADOUT_ID) return "Solo";
  const loadouts = withSolo(
    resolveProjectSettings(settings, row.projectId, project ?? undefined).settings.loadouts,
  );
  return resolveLoadout(loadouts, row.loadoutId).name;
}

function OverviewTableRow({ row, nowMs }: { row: ThreadOverviewRow; nowMs: number }) {
  const loadoutName = useLoadoutName(row);
  return (
    <TableRow>
      <TableCell>
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(scopeThreadRef(row.environmentId, row.threadId))}
          className="block max-w-96 truncate font-medium hover:underline"
        >
          {row.title}
        </Link>
      </TableCell>
      <TableCell>
        <LedgerCell ledger={row.ledger} />
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">{loadoutName}</span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground tabular-nums">
          {formatRelativeTimeLabel(row.updatedAt, nowMs)}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant={NOW_VARIANTS[row.now]} size="sm">
          {NOW_LABELS[row.now]}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

export function OverviewPage() {
  const shells = useThreadShells();
  // Read once per visit: the clock only feeds the relative labels, and one that ticked would
  // re-render every row.
  const [nowMs] = useState(() => Date.now());
  const rows = deriveThreadOverviewRows(shells);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 sm:p-6">
      <h1 className="mb-4 text-lg font-semibold">Overview</h1>
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No active threads</EmptyTitle>
            <EmptyDescription>Threads you start will show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Thread</TableHead>
              <TableHead>Ledger</TableHead>
              <TableHead>Loadout</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>Now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <OverviewTableRow
                key={`${row.environmentId}:${row.threadId}`}
                row={row}
                nowMs={nowMs}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
