import { IChatHistoryItem } from '@bike4mind/common';
import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import type { IChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { checkQuestTimeout } from '@client/app/utils/sessionsAPICalls';
import { updateAllQueryData } from '@client/app/utils/react-query';
import type { Dispatch, SetStateAction } from 'react';

/**
 * How often to re-poll the server for a seemingly-stuck 'running' quest's authoritative state.
 * Well under the check-timeout endpoint's 120s stuck threshold so a genuinely stalled quest is
 * recovered within a poll or two of crossing it, while a live (heartbeating) render is just left
 * to keep streaming. See the recovery-poll effect below.
 */
const STREAMING_RECOVERY_POLL_MS = 20_000;

type UseStreamingMessageMergeParams = {
  sessionId: string;
  /** Flattened + de-duplicated quests from the paginated React Query cache. */
  flattenQuests: IChatHistoryItem[];
  chatCompletion: IChatCompletion;
  setChatCompletion: Dispatch<SetStateAction<IChatCompletion>>;
};

type UseStreamingMessageMergeReturn = {
  /** The quest to render in the streaming slot - merged streaming data over the
   *  cached quest, or null when nothing is actively streaming. */
  streamingMessageData: IChatHistoryItem | null;
  /** Id of the quest currently being streamed (derived from streamingMessageData). */
  activeStreamingQuestId: string | null;
  /** True when a 'running' quest is visible in ChatHistory but streaming data
   *  hasn't arrived yet - render a standalone spinner for this window. */
  showOptimisticSpinner: boolean;
  /** True while a quest is actively streaming (streamingMessageData is set). */
  isStreaming: boolean;
};

/**
 * Owns the streaming display merge for SessionMiddle: combining live WebSocket
 * chat-completion data with the paginated quest cache, plus the safety-valve
 * effects that recover stale/stalled 'running' quests. Extracted from
 * SessionMiddle.tsx.
 */
export function useStreamingMessageMerge({
  sessionId,
  flattenQuests,
  chatCompletion,
  setChatCompletion,
}: UseStreamingMessageMergeParams): UseStreamingMessageMergeReturn {
  const queryClient = useQueryClient();
  const resetStreaming = useStreamingState(s => s.resetStreaming);

  // Build streaming quest's messageData separately to avoid rerendering sibling MessageContent
  // Also handles quests with status 'running' that haven't started streaming yet
  const streamingMessageData = useMemo<IChatHistoryItem | null>(() => {
    // Case 1: Active streaming or just-completed quest via chatCompletion
    if (chatCompletion.quest?.id) {
      // If the quest belongs to a different session, don't show it here.
      // This prevents a completed quest from bleeding into a different notebook
      // after the user switches sessions.
      if (chatCompletion.quest.sessionId && chatCompletion.quest.sessionId !== sessionId) {
        return null;
      }

      // If streaming completed, check if the quest is already in ChatHistory
      // before dropping the streaming view. This prevents a "gap" where fast responses
      // cause React 18 batching to skip intermediate streaming renders entirely,
      // leaving the quest visible in neither StreamingMessage nor ChatHistory.
      if (chatCompletion.completed) {
        const inChatHistory = flattenQuests.some(q => q.id === chatCompletion.quest?.id && q.status === 'done');
        if (inChatHistory) {
          return null; // Quest confirmed in ChatHistory — safe to hand off
        }
      }

      const baseQuest = flattenQuests.find(q => q.id === chatCompletion.quest?.id);
      if (baseQuest) {
        // any: chatCompletion.quest is the Zod-inferred StreamedChatCompletionAction['quest'] shape, which does not model promptMeta
        const streamingPromptMeta = (chatCompletion.quest as any).promptMeta;
        // Shallow-merge streaming promptMeta over base so citables overlay without
        // dropping other fields (context, functionCalls, model, etc.)
        const mergedPromptMeta = streamingPromptMeta
          ? { ...baseQuest.promptMeta, ...streamingPromptMeta }
          : baseQuest.promptMeta;
        return {
          ...baseQuest,
          replies: chatCompletion.quest.replies || [],
          deepResearchState: chatCompletion.quest.deepResearchState,
          prompt: chatCompletion.quest.prompt || baseQuest.prompt,
          images: chatCompletion.quest.images || baseQuest.images,
          videos: chatCompletion.quest.videos || baseQuest.videos,
          status: chatCompletion.quest.status || baseQuest.status,
          promptMeta: mergedPromptMeta,
        };
      }
      // Fallback: streaming chunks arrived before React Query loaded the quest.
      // Use chatCompletion.quest directly so the user sees tokens appearing
      // instead of a blank screen. Race condition on /opti + fresh sessions.
      const sq = chatCompletion.quest;
      return {
        id: sq.id,
        sessionId: sq.sessionId,
        prompt: sq.prompt || '',
        replies: sq.replies || [],
        reply: sq.replies?.[sq.replies.length - 1] ?? sq.reply ?? null,
        images: sq.images || [],
        videos: sq.videos || [],
        status: sq.status || 'running',
        type: sq.type || 'message',
        deepResearchState: sq.deepResearchState,
        questMasterReply: sq.questMasterReply,
        questMasterPlanId: sq.questMasterPlanId,
        // any: sq is the Zod-inferred StreamedChatCompletionAction['quest'] shape, which does not model promptMeta
        promptMeta: (sq as any).promptMeta,
      } as IChatHistoryItem;
    }

    // Case 2: Quest is 'running' but streaming hasn't started yet (no chatCompletion.quest.id)
    // Skip if the running quest is the same one that just finished streaming -
    // that means flattenQuests is stale and will refetch with final data shortly.
    const latestQuest = flattenQuests[0];
    if (latestQuest?.status === 'running' && latestQuest.id !== chatCompletion.quest?.id) {
      return latestQuest;
    }

    return null;
  }, [chatCompletion.quest, chatCompletion.completed, flattenQuests, sessionId]);

  // Derived from streamingMessageData so they're always in sync - prevents duplicate keys
  const activeStreamingQuestId = streamingMessageData?.id ?? null;

  // Detect when a 'running' quest is in ChatHistory but streaming data hasn't arrived yet.
  // This happens during the window between optimistic cache insert and the first WebSocket
  // chunk - the prompt bubble shows via ChatHistory but there's no spinner. We render a
  // standalone ReplyStatus spinner below ChatHistory for this case.
  const showOptimisticSpinner = useMemo(() => {
    if (streamingMessageData) return false; // Streaming status is shown in the Footer
    const latest = flattenQuests[0];
    return latest?.status === 'running';
  }, [streamingMessageData, flattenQuests]);

  // Safety valve: if a quest shows 'running' but no streaming data arrives
  // within 10 seconds, force a refetch. This catches stale IndexedDB cache
  // after page refresh (especially in incognito mode where persisted cache
  // may contain an intermediate 'running' snapshot from a previous load).
  useEffect(() => {
    const latest = flattenQuests[0];
    if (!latest || latest.status !== 'running') return;
    if (chatCompletion.quest?.id) return;

    const timer = setTimeout(() => {
      queryClient.invalidateQueries({
        queryKey: ['quests', 'session', sessionId],
      });
    }, 10000);

    return () => clearTimeout(timer);
  }, [flattenQuests, chatCompletion.quest?.id, sessionId, queryClient]);

  // Streaming recovery poll: while a 'running' quest sits with no replies (the image-generation
  // shape - text replies are empty and the only signal is the WebSocket stream), poll the server
  // for its authoritative state. Two failure modes strand the client on an eternal "Running..."
  // spinner, both invisible to the WebSocket stream:
  //   1. A hung/killed generation Lambda that never emits its terminal frame. The backend running
  //      heartbeat keeps updatedAt fresh while alive, so check-timeout only flips the quest
  //      to done+error once it has genuinely stalled past the server's 120s threshold.
  //   2. A successful generation whose terminal WebSocket frame was lost (e.g. the socket churned
  //      during a multi-minute render). The quest is already 'done' in the DB with its images.
  // In both cases the server's response is terminal (status === 'done'); applying it hands the quest
  // off to ChatHistory and clears the spinner. A single one-shot check could never win here: it
  // fired at 90s (< the server's 120s stuck threshold), so it always saw "not stuck" and then never
  // retried. Polling until terminal is what actually recovers the quest.
  useEffect(() => {
    const questId = streamingMessageData?.id;
    if (!questId) return;
    if (streamingMessageData.replies?.length) return;
    if (streamingMessageData.status !== 'running') return;

    let cancelled = false;

    const poll = async () => {
      try {
        const updatedQuest = await checkQuestTimeout(questId);
        if (cancelled) return;
        if (updatedQuest.status === 'done') {
          updateAllQueryData(queryClient, 'quests', 'write', updatedQuest, {
            keysAllowedToCreate: [['quests', 'session', sessionId]],
          });
          setChatCompletion({ quest: undefined, completed: true, stopped: false });
          resetStreaming(sessionId);
          clearInterval(interval);
        }
      } catch (error) {
        // Transient failure - keep polling on the next tick, but surface it so auth/network
        // problems are visible while debugging rather than silently swallowed.
        console.warn('Streaming recovery poll (checkQuestTimeout) failed; will retry:', error);
      }
    };

    const interval = setInterval(poll, STREAMING_RECOVERY_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // streamingMessageData is a fresh object whenever the merge recomputes, so its
    // reference covers any change to .id/.replies/.status - no need to list those separately.
  }, [streamingMessageData, queryClient, sessionId, setChatCompletion, resetStreaming]);

  const isStreaming = !!streamingMessageData;

  return {
    streamingMessageData,
    activeStreamingQuestId,
    showOptimisticSpinner,
    isStreaming,
  };
}
