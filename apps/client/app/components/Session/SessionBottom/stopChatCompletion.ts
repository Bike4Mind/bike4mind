import type { Dispatch, SetStateAction } from 'react';
import type { IChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { resolveStopFailure } from '@client/app/hooks/chatCompletionState';

export const CANCELLING_STATUS = 'Cancelling generation...';

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
}): Promise<boolean> {
  const { sessionId, setChatCompletion, stop, getCachedQuestStatus } = params;
  let beforeStop: IChatCompletion | undefined;
  setChatCompletion(prev => {
    beforeStop = prev;
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
