import type { Dispatch, SetStateAction } from 'react';
import type { IChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { resolveStopFailure } from '@client/app/hooks/chatCompletionState';
import { isOptimisticId } from '@client/app/utils/llm';

export const CANCELLING_STATUS = 'Cancelling generation...';

// Matches the send request's own timeout: a quest that has not appeared by then never will.
export const DEFERRED_STOP_TIMEOUT_MS = 60_000;

/**
 * True when a Stop can be sent now. stop-reply marks the session's latest quest stopped, so it
 * needs a real session id and a quest that already exists server-side.
 */
export function canStopNow(sessionId: string | null | undefined, current: IChatCompletion): sessionId is string {
  return !!sessionId && !isOptimisticId(sessionId) && !!current.quest?.id;
}

/**
 * Holds a Stop pressed before the turn's quest exists (a new notebook's optimistic window, or
 * before the send request returns), showing "Cancelling..." meanwhile. resolve() hands back the
 * real session id to stop once the held quest has an id; a turn that ends first drops it quietly.
 * cancel() drops it and restores the pre-stop state (send failure, timeout).
 */
export class DeferredStop {
  private pending: { beforeStop: IChatCompletion; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly setChatCompletion: Dispatch<SetStateAction<IChatCompletion>>,
    private readonly timeoutMs = DEFERRED_STOP_TIMEOUT_MS
  ) {}

  get isPending(): boolean {
    return this.pending !== null;
  }

  request(current: IChatCompletion): void {
    if (this.pending) return;
    this.pending = { beforeStop: current, timer: setTimeout(() => this.cancel(), this.timeoutMs) };
    // No session id is stamped on the placeholder: the optimistic one would read as a foreign
    // quest once the real id resolves, and reset the state.
    this.setChatCompletion(prev => ({ ...prev, stopped: true, statusMessage: CANCELLING_STATUS }));
  }

  /** The session id to send the held Stop to, with the state to restore if it fails; null while waiting. */
  resolve(current: IChatCompletion): { sessionId: string; beforeStop: IChatCompletion } | null {
    if (!this.pending) return null;
    if (current.completed) {
      this.cancel();
      return null;
    }
    const sessionId = current.quest?.sessionId;
    if (!current.quest?.id || !sessionId || isOptimisticId(sessionId)) return null;
    const { beforeStop } = this.pending;
    this.drop();
    return { sessionId, beforeStop };
  }

  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.drop();
    this.setChatCompletion(prev => resolveStopFailure(prev, pending.beforeStop, undefined, CANCELLING_STATUS));
  }

  /** Forget the held Stop without touching state. */
  drop(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}

/**
 * Drives the composer's chat-completion state through a Stop request: "Cancelling..." while it
 * is in flight, cancelled on success, and a consistent state on failure (see
 * resolveStopFailure). Returns false when the request failed so the caller can surface it.
 */
export async function stopChatCompletion(params: {
  sessionId: string;
  setChatCompletion: Dispatch<SetStateAction<IChatCompletion>>;
  stop: (sessionId: string) => Promise<unknown>;
  /** Cached status of a quest in this session, if the quest list holds it. */
  getCachedQuestStatus: (questId: string) => string | null | undefined;
  /** State to restore on failure when the Stop was held (the current one already reads "Cancelling..."). */
  restoreTo?: IChatCompletion;
}): Promise<boolean> {
  const { sessionId, setChatCompletion, stop, getCachedQuestStatus, restoreTo } = params;
  let beforeStop: IChatCompletion | undefined = restoreTo;
  setChatCompletion(prev => {
    beforeStop ??= prev;
    return {
      ...prev,
      // Keep a held quest's own (real) session id: stamping the optimistic id onto it would
      // read as a foreign quest once the id resolves, and reset the state.
      quest: { ...prev.quest, sessionId: prev.quest?.sessionId ?? sessionId },
      stopped: true,
      statusMessage: CANCELLING_STATUS,
    };
  });

  try {
    await stop(sessionId);
    setChatCompletion(prev => ({
      ...prev,
      completed: true,
      statusMessage: 'Generation cancelled by user',
      // Same reason as the send-time reset: a cancelled turn keeps the streaming
      // slot, so its acknowledgement would outlive it.
      rapidReply: undefined,
    }));
    return true;
  } catch (error) {
    console.error('Error stopping chat message:', error);
    // Leaving "Cancelling..." with completed: false would pin Stop on screen for good.
    setChatCompletion(prev => {
      const cachedStatus = prev.quest?.id ? getCachedQuestStatus(prev.quest.id) : undefined;
      return resolveStopFailure(prev, beforeStop ?? prev, cachedStatus, CANCELLING_STATUS);
    });
    return false;
  }
}
