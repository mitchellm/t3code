import { CommandId, type ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadTitleManager,
  type ThreadTitleManagerShape,
} from "../Services/ThreadTitleManager.ts";

type SkippedReason = "no-user-messages" | "unchanged";

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

function normalizeUserMessages(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
  }>,
): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.replace(/\s+/g, " ").trim())
    .filter((message) => message.length > 0);
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;

  const autorenameProjectThreads: ThreadTitleManagerShape["autorenameProjectThreads"] = (
    projectId,
  ) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const project = readModel.projects.find(
        (entry) => entry.id === projectId && entry.deletedAt === null,
      );

      if (!project) {
        return {
          renamed: [],
          skipped: [],
          failed: [],
        };
      }

      const renamed: Array<{ threadId: ThreadId; title: string }> = [];
      const skipped: Array<{ threadId: ThreadId; reason: SkippedReason }> = [];
      const failed: Array<{ threadId: ThreadId; message: string }> = [];

      const threads = readModel.threads.filter(
        (thread) => thread.projectId === projectId && thread.deletedAt === null,
      );

      for (const thread of threads) {
        const userMessages = normalizeUserMessages(thread.messages);
        if (userMessages.length === 0) {
          skipped.push({ threadId: thread.id, reason: "no-user-messages" });
          continue;
        }

        const cwd =
          resolveThreadWorkspaceCwd({
            thread,
            projects: readModel.projects,
          }) ?? project.workspaceRoot;

        const generatedTitle = yield* textGeneration
          .generateThreadTitle({
            cwd,
            currentTitle: thread.title,
            originalMessage: userMessages[0] ?? thread.title,
            recentMessages: userMessages,
          })
          .pipe(
            Effect.map((result) => result.title.trim()),
            Effect.catch((error) =>
              Effect.succeed({
                error: error.message,
              } as const),
            ),
          );

        if (typeof generatedTitle === "object" && "error" in generatedTitle) {
          failed.push({
            threadId: thread.id,
            message: generatedTitle.error,
          });
          continue;
        }

        if (generatedTitle === thread.title) {
          skipped.push({ threadId: thread.id, reason: "unchanged" });
          continue;
        }

        const dispatchResult = yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("thread-autorename"),
            threadId: thread.id,
            title: generatedTitle,
          })
          .pipe(
            Effect.as({ ok: true } as const),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false,
                error: error.message,
              } as const),
            ),
          );

        if (!dispatchResult.ok) {
          failed.push({
            threadId: thread.id,
            message: dispatchResult.error,
          });
          continue;
        }

        renamed.push({
          threadId: thread.id,
          title: generatedTitle,
        });
      }

      return {
        renamed,
        skipped,
        failed,
      };
    });

  return {
    autorenameProjectThreads,
  } satisfies ThreadTitleManagerShape;
});

export const ThreadTitleManagerLive = Layer.effect(ThreadTitleManager, make);
