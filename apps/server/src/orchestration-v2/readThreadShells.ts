import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Reads the shell of every listed thread, `null` where a thread is gone. One thread keeps the
 * single-thread read; several share one snapshot query instead of five queries each. Without a
 * `location` the snapshot returns active and archived threads, matching `getThreadShell`.
 */
export const readThreadShells = Effect.fn("readThreadShells")(function* (
  threads: Pick<
    ThreadManagement.ThreadManagementService["Service"],
    "getThreadShell" | "getShellSnapshot"
  >,
  threadIds: ReadonlyArray<ThreadId>,
) {
  const uniqueIds = [...new Set(threadIds)];
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
  if (uniqueIds.length === 1) {
    const [threadId] = uniqueIds;
    if (threadId !== undefined) shells.set(threadId, yield* threads.getThreadShell(threadId));
  } else if (uniqueIds.length > 1) {
    const snapshot = yield* threads.getShellSnapshot({ threadIds: uniqueIds });
    for (const shell of [...snapshot.threads, ...snapshot.archivedThreads]) {
      shells.set(shell.id, shell);
    }
  }
  return {
    get: (threadId: ThreadId) => shells.get(threadId) ?? null,
  };
});
