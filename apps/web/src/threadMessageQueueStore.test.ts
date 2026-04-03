import { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  clearQueuedSubmissions,
  dequeueQueuedSubmission,
  enqueueQueuedSubmission,
  prependQueuedSubmission,
  removeQueuedSubmission,
  setThreadInterrupting,
  type QueuedThreadSubmission,
} from "./threadMessageQueueStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeSubmission(messageId: string): QueuedThreadSubmission {
  return {
    messageId: MessageId.makeUnsafe(messageId),
    createdAt: "2026-03-09T12:00:00.000Z",
    text: `message:${messageId}`,
    attachments: [],
    runtimeMode: "full-access",
    interactionMode: "default",
    assistantDeliveryMode: "streaming",
  };
}

describe("threadMessageQueueStore helpers", () => {
  it("enqueues submissions in FIFO order", () => {
    const first = makeSubmission("message-1");
    const second = makeSubmission("message-2");

    const queued = enqueueQueuedSubmission({}, THREAD_ID, first);
    const next = enqueueQueuedSubmission(queued, THREAD_ID, second);

    expect(next[THREAD_ID]).toEqual([first, second]);
  });

  it("dequeues the next submission and removes empty thread queues", () => {
    const first = makeSubmission("message-1");
    const second = makeSubmission("message-2");
    const queued = {
      [THREAD_ID]: [first, second],
    };

    const firstResult = dequeueQueuedSubmission(queued, THREAD_ID);
    expect(firstResult.submission).toEqual(first);
    expect(firstResult.queuedByThreadId[THREAD_ID]).toEqual([second]);

    const secondResult = dequeueQueuedSubmission(firstResult.queuedByThreadId, THREAD_ID);
    expect(secondResult.submission).toEqual(second);
    expect(secondResult.queuedByThreadId[THREAD_ID]).toBeUndefined();
  });

  it("prepends interrupt-send submissions ahead of existing queued work", () => {
    const first = makeSubmission("message-1");
    const urgent = makeSubmission("message-urgent");
    const queued = {
      [THREAD_ID]: [first],
    };

    const next = prependQueuedSubmission(queued, THREAD_ID, urgent);

    expect(next[THREAD_ID]).toEqual([urgent, first]);
  });

  it("removes a queued submission by message id", () => {
    const first = makeSubmission("message-1");
    const second = makeSubmission("message-2");
    const queued = {
      [THREAD_ID]: [first, second],
    };

    const next = removeQueuedSubmission(queued, THREAD_ID, first.messageId);

    expect(next[THREAD_ID]).toEqual([second]);
  });

  it("clears a thread queue", () => {
    const queued = {
      [THREAD_ID]: [makeSubmission("message-1")],
    };

    expect(clearQueuedSubmissions(queued, THREAD_ID)).toEqual({});
  });

  it("tracks interrupting state by thread id", () => {
    const interrupting = setThreadInterrupting({}, THREAD_ID, true);
    expect(interrupting[THREAD_ID]).toBe(true);

    const cleared = setThreadInterrupting(interrupting, THREAD_ID, false);
    expect(cleared[THREAD_ID]).toBeUndefined();
  });
});
