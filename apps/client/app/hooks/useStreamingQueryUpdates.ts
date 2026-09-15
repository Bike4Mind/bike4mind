import { useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { replaceQueryData, updateSingleQueryDataFast } from '../utils/react-query';

/**
 * useStreamingQueryUpdates - owns the React Query cache updates applied as
 * streaming chunks arrive.
 *
 * Extracted from useSubscribeChatCompletion. Owns the
 * cache-key knowledge, the optimistic-quest replacement on the first chunk, the
 * "never regress reply text" invariant, and the final completion writes.
 *
 * Callers pass the quest + completion flag; the hook decides which cache entries
 * to touch and preserves the in-flight stream state across chunks.
 */
export function useStreamingQueryUpdates(params: {
  // The hook only reads the current rapidReply flag to decide whether a shorter
  // reply should be suppressed, then pushes streaming state back to the caller.
  // The chatCompletion shape is owned by useSubscribeChatCompletion; we depend
  // on just the rapidReply field (narrowed to its `status` discriminant) so the
  // full type - with its nullable quest - stays loosely coupled. The real
  // rapidReply object satisfies this structurally.
  chatCompletionRef: { readonly current: { rapidReply?: { status?: string } } };
  // any: setter is generic over the caller's full chatCompletion state shape,
  // which the hook intentionally does not import to avoid a circular dependency.
  setChatCompletion: React.Dispatch<React.SetStateAction<any>>;
}) {
  const { chatCompletionRef, setChatCompletion } = params;
  const queryClient = useQueryClient();

  // Stream React Query updates during streaming.
  const streamRef = useRef({
    timeoutId: null as NodeJS.Timeout | null,
    lastUpdate: 0,
    previousQuest: null as any,
    updateInterval: 250, // Reduced to 250ms for smooth streaming experience (was 1000ms)
    isStreamingActive: false, // Track if we're in active streaming mode
  });

  // Streaming React Query updates that drive UI updates mid-stream (mainly the quest reply).
  const updateStreamingQuest = useCallback(
    (quest: any, isComplete = false, statusMessage?: string | null) => {
      const stream = streamRef.current;
      const now = Date.now();
      // To avoid UI update stutters we dont include empty replies or replies that are shorter than the previous quest
      // BUT: Allow rapid reply to coexist with main response streaming
      let questForUpdate = quest;
      if (quest.replies && stream.previousQuest?.replies) {
        const currentRepliesLength = quest.replies.join('').length;
        const previousRepliesLength = stream.previousQuest.replies.join('').length;

        // Only prevent updates if we're not in rapid reply mode and the reply is actually shorter
        // This allows proper streaming of the main response even when rapid reply is present
        if (currentRepliesLength < previousRepliesLength && !chatCompletionRef.current.rapidReply) {
          questForUpdate = { ...quest, replies: stream.previousQuest.replies };
        }
      }
      // Make sure we are replacing temp quests if it exists
      // Only attempt replace for first stream messge
      if (!stream.previousQuest) {
        // Find the optimistic quest id by scanning the cache. The id is
        // `optimistic-quest-${sessionId}`, but `sessionId` here may be the
        // client-generated optimistic tmpId (set in useSendMessage when
        // creating a session from /new) rather than the real session id that
        // the streaming chunk carries. Scanning by prefix lets us find it
        // regardless of which id was used to create the placeholder.
        const cacheKey = ['quests', 'session', quest.sessionId] as const;
        const cached = queryClient.getQueryData<{ pages?: { data: { id: string }[] }[] }>(cacheKey);
        const optimisticIdInCache = cached?.pages
          ?.flatMap(page => page.data)
          .find(item => item?.id?.startsWith('optimistic-quest-'))?.id;
        const replaceId = optimisticIdInCache ?? `optimistic-quest-${quest.sessionId}`;
        // Replace the optimistic quest
        replaceQueryData(queryClient, cacheKey, replaceId, questForUpdate);
      }
      stream.previousQuest = quest;

      // If completed, update immediately and clear any pending updates
      if (isComplete) {
        stream.lastUpdate = now;
        stream.previousQuest = null;

        // Update or create the quest if not found
        updateSingleQueryDataFast(queryClient, ['quests', 'session', quest.sessionId], 'write', questForUpdate, {
          keysAllowedToCreate: [['quests', 'session', quest.sessionId]],
        });

        // Also update individual quest cache for SubQuestCard polling
        // so the "Completing..." spinner shows when the LLM response finishes
        if (quest.id) {
          queryClient.setQueryData(['quests', 'individual', quest.sessionId, quest.id], questForUpdate);
        }
      }

      // Send stream updates.
      // Mid-stream the backend sends a null status on every token chunk and on its keepalive
      // heartbeat (ChatCompletionProcess throttledSend). Overwriting unconditionally would wipe a
      // real progress message (e.g. "retrying... attempt 1/3") milliseconds after it appears,
      // which is why long tool runs showed only a brief flash then a blank screen. Preserve the
      // last real status while streaming; only let a completion clear it.
      setChatCompletion((prev: any) => ({
        ...prev,
        completed: isComplete,
        quest: prev.quest?.id === quest.id ? { ...prev.quest, ...questForUpdate } : questForUpdate,
        statusMessage: isComplete ? statusMessage : statusMessage || prev.statusMessage,
      }));
    },
    [queryClient, chatCompletionRef, setChatCompletion]
  );

  // Clear any pending stream updates. Called on subscription teardown.
  const cleanupStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream.timeoutId) {
      clearTimeout(stream.timeoutId);
      stream.timeoutId = null;
    }
  }, []);

  // Memoized for symmetry with the sibling streaming hooks: a stable wrapper
  // object so callers that destructure or spread it don't churn per render.
  return useMemo(() => ({ updateStreamingQuest, cleanupStream }), [updateStreamingQuest, cleanupStream]);
}
