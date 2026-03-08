import type {
  OrchestrationAutorenameProjectThreadsResult,
  ProjectId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ThreadTitleManagerShape {
  readonly autorenameProjectThreads: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationAutorenameProjectThreadsResult>;
}

export class ThreadTitleManager extends ServiceMap.Service<
  ThreadTitleManager,
  ThreadTitleManagerShape
>()("t3/orchestration/Services/ThreadTitleManager") {}
