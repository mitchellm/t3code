/**
 * Fork: the thread state the harness hooks read (see Adapters/HarnessHooks.ts). Reads are
 * thread-scoped rather than run-scoped because a Claude session outlives the turn that opened it.
 */
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Run,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2HarnessLedgerState,
  ProviderAdapterV2HarnessPort,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { loadoutStructure, resolveLoadout } from "@t3tools/shared/loadouts";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "./ProjectionStore.ts";

const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "starting",
  "running",
  "waiting",
]);

export interface HarnessThreadReads {
  readonly readLedgerState: () => Effect.Effect<
    ProviderAdapterV2HarnessLedgerState,
    ProjectionStore.ProjectionStoreV2Error
  >;
  readonly readThreadLoadout: () => Effect.Effect<
    { readonly projectId: ProjectId; readonly loadoutId: string | null },
    ProjectionStore.ProjectionStoreV2Error
  >;
}

/** The settings the hooks act on, as resolved for the thread's project. */
export type HarnessProjectSettings = Pick<ServerSettings, "loadouts" | "planBeforeEditing">;

export function makeHarnessThreadReads(
  projectionStore: Pick<ProjectionStore.ProjectionStoreV2["Service"], "getThreadRecords">,
  threadId: ThreadId,
  /** The interrupt message a person's Stop records; agents and the server stop runs too. */
  userStopReason: string,
): HarnessThreadReads {
  return {
    readLedgerState: () =>
      projectionStore
        .getThreadRecords(threadId, ["ledger", "subagents", "runs", "turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
        })
        .pipe(
          Effect.map(({ ledger, subagents, runs, turnItems }) => {
            const liveRunIds = new Set(
              runs.filter((run) => LIVE_RUN_STATUSES.has(run.status)).map(({ id }) => id),
            );
            return {
              ledger: ledger ?? null,
              userInterrupted: turnItems.some(
                (item) =>
                  item.type === "run_interrupt_request" &&
                  item.message === userStopReason &&
                  item.runId !== null &&
                  liveRunIds.has(item.runId),
              ),
              delegatedWorkActive: subagents.some((subagent) =>
                isOrchestrationV2WorkActive(subagent.status),
              ),
            };
          }),
        ),
    readThreadLoadout: () =>
      projectionStore.getThreadRecords(threadId, []).pipe(
        Effect.map(({ thread }) => ({
          projectId: thread.projectId,
          loadoutId: thread.loadout?.id ?? null,
        })),
      ),
  };
}

/** A failed read resolves undefined (logged) so a hook falls back to doing nothing. */
export function makeHarnessPort<E>(
  reads: HarnessThreadReads,
  readProjectSettings: (projectId: ProjectId) => Effect.Effect<HarnessProjectSettings, E>,
): ProviderAdapterV2HarnessPort {
  const orUndefined = <A, F>(effect: Effect.Effect<A, F>, what: string) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`Failed to read the ${what} for the harness hooks.`, { cause }).pipe(
          Effect.as<A | undefined>(undefined),
        ),
      ),
    );
  return {
    readLedgerState: orUndefined(Effect.suspend(reads.readLedgerState), "ledger"),
    readThreadPolicy: orUndefined(
      Effect.gen(function* () {
        const { projectId, loadoutId } = yield* reads.readThreadLoadout();
        const settings = yield* readProjectSettings(projectId);
        return {
          structure: loadoutStructure(resolveLoadout(settings.loadouts, loadoutId)),
          planBeforeEditing: settings.planBeforeEditing,
        };
      }),
      "loadout and plan before editing setting",
    ),
  };
}
