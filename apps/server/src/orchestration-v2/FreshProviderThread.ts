// Fork: where a thread's provider context begins after Reset and build (`freshProviderThread`).
import type { OrchestrationV2Run } from "@t3tools/contracts";

/**
 * The first run ordinal a rebuilt native context may cover: the latest reset on the same
 * instance before `run`, else the thread's first run. A reset deliberately dropped what came
 * before it, so a summary must not bring it back.
 */
export function contextStartOrdinal(
  runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "ordinal" | "providerInstanceId" | "freshProviderThread">
  >,
  run: Pick<OrchestrationV2Run, "ordinal" | "providerInstanceId">,
): number {
  let start = 1;
  for (const candidate of runs) {
    if (
      candidate.freshProviderThread === true &&
      candidate.providerInstanceId === run.providerInstanceId &&
      candidate.ordinal < run.ordinal &&
      candidate.ordinal > start
    ) {
      start = candidate.ordinal;
    }
  }
  return start;
}
