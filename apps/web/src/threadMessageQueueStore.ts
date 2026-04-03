import type {
  AssistantDeliveryMode,
  MessageId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  ProviderServiceTier,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerImageAttachment } from "./composerDraftStore";

export const EMPTY_QUEUE: QueuedThreadSubmission[] = [];

export interface QueuedThreadSubmission {
  messageId: MessageId;
  createdAt: string;
  text: string;
  attachments: ComposerImageAttachment[];
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  serviceTier?: ProviderServiceTier | null | undefined;
  modelOptions?: ProviderModelOptions | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  assistantDeliveryMode: AssistantDeliveryMode;
}

interface DequeueQueuedSubmissionResult {
  queuedByThreadId: Record<ThreadId, QueuedThreadSubmission[]>;
  submission: QueuedThreadSubmission | null;
}

export function enqueueQueuedSubmission(
  queuedByThreadId: Record<ThreadId, QueuedThreadSubmission[]>,
  threadId: ThreadId,
  submission: QueuedThreadSubmission,
): Record<ThreadId, QueuedThreadSubmission[]> {
  const existing = queuedByThreadId[threadId] ?? [];
  return {
    ...queuedByThreadId,
    [threadId]: [...existing, submission],
  };
}

export function prependQueuedSubmission(
  queuedByThreadId: Record<ThreadId, QueuedThreadSubmission[]>,
  threadId: ThreadId,
  submission: QueuedThreadSubmission,
): Record<ThreadId, QueuedThreadSubmission[]> {
  const existing = queuedByThreadId[threadId] ?? [];
  return {
    ...queuedByThreadId,
    [threadId]: [submission, ...existing],
  };
}

export function dequeueQueuedSubmission(
  queuedByThreadId: Record<ThreadId, QueuedThreadSubmission[]>,
  threadId: ThreadId,
): DequeueQueuedSubmissionResult {
  const existing = queuedByThreadId[threadId];
  if (!existing || existing.length === 0) {
    return {
      queuedByThreadId,
      submission: null,
    };
  }

  const [submission, ...rest] = existing;
  if (!submission) {
    return {
      queuedByThreadId,
      submission: null,
    };
  }

  if (rest.length === 0) {
    const next = { ...queuedByThreadId };
    delete next[threadId];
    return {
      queuedByThreadId: next,
      submission,
    };
  }

  return {
    queuedByThreadId: {
      ...queuedByThreadId,
      [threadId]: rest,
    },
    submission,
  };
}

export function removeQueuedSubmission(
  queuedByThreadId: Record<ThreadId, QueuedThreadSubmission[]>,
  threadId: ThreadId,
  messageId: MessageId,
): Record<ThreadId, QueuedThreadSubmission[]> {
  const existing = queuedByThreadId[threadId];
  if (!existing || existing.length === 0) {
    return queuedByThreadId;
  }

  const nextQueue = existing.filter((submission) => submission.messageId !== messageId);
  if (nextQueue.length === existing.length) {
    return queuedByThreadId;
  }

  if (nextQueue.length === 0) {
    const next = { ...queuedByThreadId };
    delete next[threadId];
    return next;
  }

  return {
    ...queuedByThreadId,
    [threadId]: nextQueue,
  };
}

export function clearQueuedSubmissions(
  queuedByThreadId: Record<ThreadId, QueuedThreadSubmission[]>,
  threadId: ThreadId,
): Record<ThreadId, QueuedThreadSubmission[]> {
  if (!(threadId in queuedByThreadId)) {
    return queuedByThreadId;
  }
  const next = { ...queuedByThreadId };
  delete next[threadId];
  return next;
}

export function setThreadInterrupting(
  interruptingByThreadId: Record<ThreadId, true>,
  threadId: ThreadId,
  isInterrupting: boolean,
): Record<ThreadId, true> {
  if (isInterrupting) {
    if (interruptingByThreadId[threadId]) {
      return interruptingByThreadId;
    }
    return {
      ...interruptingByThreadId,
      [threadId]: true,
    };
  }

  if (!(threadId in interruptingByThreadId)) {
    return interruptingByThreadId;
  }

  const next = { ...interruptingByThreadId };
  delete next[threadId];
  return next;
}

interface ThreadMessageQueueStore {
  queuedByThreadId: Record<ThreadId, QueuedThreadSubmission[]>;
  interruptingByThreadId: Record<ThreadId, true>;
  enqueueSubmission: (threadId: ThreadId, submission: QueuedThreadSubmission) => void;
  prependSubmission: (threadId: ThreadId, submission: QueuedThreadSubmission) => void;
  dequeueSubmission: (threadId: ThreadId) => QueuedThreadSubmission | null;
  removeSubmission: (threadId: ThreadId, messageId: MessageId) => void;
  clearThreadQueue: (threadId: ThreadId) => void;
  setInterrupting: (threadId: ThreadId, isInterrupting: boolean) => void;
}

export const useThreadMessageQueueStore = create<ThreadMessageQueueStore>((set, get) => ({
  queuedByThreadId: {},
  interruptingByThreadId: {},
  enqueueSubmission: (threadId, submission) =>
    set((state) => ({
      queuedByThreadId: enqueueQueuedSubmission(state.queuedByThreadId, threadId, submission),
    })),
  prependSubmission: (threadId, submission) =>
    set((state) => ({
      queuedByThreadId: prependQueuedSubmission(state.queuedByThreadId, threadId, submission),
    })),
  dequeueSubmission: (threadId) => {
    const result = dequeueQueuedSubmission(get().queuedByThreadId, threadId);
    if (result.queuedByThreadId !== get().queuedByThreadId) {
      set({
        queuedByThreadId: result.queuedByThreadId,
      });
    }
    return result.submission;
  },
  removeSubmission: (threadId, messageId) =>
    set((state) => ({
      queuedByThreadId: removeQueuedSubmission(state.queuedByThreadId, threadId, messageId),
    })),
  clearThreadQueue: (threadId) =>
    set((state) => ({
      queuedByThreadId: clearQueuedSubmissions(state.queuedByThreadId, threadId),
    })),
  setInterrupting: (threadId, isInterrupting) =>
    set((state) => ({
      interruptingByThreadId: setThreadInterrupting(
        state.interruptingByThreadId,
        threadId,
        isInterrupting,
      ),
    })),
}));
