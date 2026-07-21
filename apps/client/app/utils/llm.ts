import type { IChatHistoryItemDocument, ISessionDocument, ModelInfo } from '@bike4mind/common';
import type { AxiosError } from 'axios';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { QueryClient } from '@tanstack/react-query';
import perfLogger from './performanceLogger';
import { replaceQueryData, setOptimisticQueryData, updateSingleQueryDataFast } from './react-query';
import { useStreamingState } from '../hooks/useStreamingState';

function getErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const data = error.response?.data;
    if (typeof data === 'string') {
      // CDN/WAF error pages (CloudFront, Cloudflare, nginx) return HTML, not
      // JSON. Dumping the raw HTML into the chat as a `**Error:** ...` reply
      // renders as garbage. Detect HTML and translate to a short, actionable
      // message, surfacing CloudFront specifically since that fronts the app
      // and is the most likely culprit.
      const trimmed = data.trim();
      if (trimmed.startsWith('<') || /<html|<!doctype/i.test(trimmed)) {
        const status = error.response?.status;
        if (/cloudfront/i.test(trimmed)) {
          return `Request blocked by CDN (CloudFront, status ${status ?? 'unknown'}). Try again, or check your VPN/network.`;
        }
        return `Request blocked at the edge (status ${status ?? 'unknown'}). Try again, or check your VPN/network.`;
      }
      return data;
    }
    if (data?.message) return data.message;
    if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred';
}

/**
 * Create a temporary quest record to show the user's prompt, then replace it
 * with the real quest record from the server.
 */
const OPTIMISTIC_PREFIX = 'optimistic-';

export function isOptimisticId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(OPTIMISTIC_PREFIX);
}

export function createOptimisticSessionId(): string {
  return `${OPTIMISTIC_PREFIX}session-${crypto.randomUUID()}`;
}

/**
 * Write a user-prompt bubble into the session's quest cache for the
 * agent_execute flow. Unlike `createOptimisticQuest`, there's no server
 * round-trip to swap in real data; the agent executor is fire-and-forget
 * and doesn't create a Quest document, so the iteration stream renders
 * separately (via `useAgentExecutionStore`). Without this, the user's
 * message bubble never mounts and the chat middle looks empty above the
 * permission card.
 *
 * Status is `done` (not `running`) so no spinner attaches; the iteration
 * stream below is the live indicator.
 */
export function createOptimisticPromptBubble(
  queryClient: QueryClient,
  sessionId: string,
  prompt: string,
  // Stamp the routing provenance onto the optimistic bubble at dispatch so the
  // AutoRouteBadge renders live during/after the agent run, not only after a
  // reload. Without it, `routingSource` first appears when the change-stream
  // delivers the persisted Quest, so the badge lagged behind the reply. The
  // downstream patchers (swapOptimisticPromptBubbleId,
  // appendReplyToLatestOptimisticBubble) spread existing fields, so this value
  // survives until the real Quest replaces the bubble.
  routingSource?: IChatHistoryItemDocument['routingSource']
) {
  const optimisticQuest: IChatHistoryItemDocument = {
    id: `optimistic-quest-${sessionId}-${Date.now()}`,
    sessionId,
    type: 'message',
    prompt,
    replies: [],
    images: [],
    status: 'done',
    timestamp: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(routingSource ? { routingSource } : {}),
  };
  setOptimisticQueryData(queryClient, ['quests', 'session', sessionId], optimisticQuest);
}

type SessionQuestPages = {
  pages: Array<{ data: IChatHistoryItemDocument[]; hasMore?: boolean }>;
  pageParams: unknown[];
};

/**
 * Re-id the most recent optimistic prompt bubble in a session to the real
 * server-side Quest id. Called from the `execution_started` WS handler once
 * the server has persisted the user's prompt; without the swap, the
 * change-stream subscriber would deliver the real Quest as a *second* bubble
 * (different id, no dedup), and on reload the optimistic bubble vanishes
 * leaving the iteration trace orphaned.
 *
 * Defensive: if the real id already exists in the cache (change-stream beat
 * `execution_started` to the punch), drops the optimistic entry instead of
 * creating a duplicate. If no optimistic bubble is found, no-op.
 *
 * KNOWN GAP - concurrent same-session dispatches: the swap finds the first
 * optimistic bubble in the cache rather than pairing it with a specific
 * `executionId`. With 2+ runs in the same session (the per-user concurrency
 * cap is 3), if `execution_started` events arrive out of order across Lambda
 * cold starts, the first event re-keys the bubble that was dispatched
 * first - which may not be the bubble for the execution that started first.
 * The end state is that two same-session bubbles in cache get each other's
 * ids until the change-stream subscriber delivers the real Quest docs and
 * dedup by id resolves it. The window is narrow (sub-second on production)
 * and only affects concurrent same-session dispatch ordering; cross-session
 * dispatches and single in-flight runs are unaffected. A proper fix would
 * thread a client-generated `dispatchId` through the WS protocol so the
 * Lambda echoes it back in `execution_started`; out of scope here.
 */
export function swapOptimisticPromptBubbleId(queryClient: QueryClient, sessionId: string, realQuestId: string): void {
  queryClient.setQueryData<SessionQuestPages>(['quests', 'session', sessionId], current => {
    if (!current?.pages) return current;
    const pages = current.pages.map(page => {
      const optimisticIdx = page.data.findIndex(
        q => typeof q.id === 'string' && q.id.startsWith('optimistic-quest-') && !!q.prompt
      );
      if (optimisticIdx < 0) return page;
      const realAlreadyPresent = page.data.some(q => q.id === realQuestId);
      const data = [...page.data];
      if (realAlreadyPresent) {
        data.splice(optimisticIdx, 1);
      } else {
        data[optimisticIdx] = { ...data[optimisticIdx], id: realQuestId };
      }
      return { ...page, data };
    });
    return { ...current, pages };
  });
}

/**
 * Patch the most recent prompt-only optimistic Quest in a session with the
 * agent's final reply. Called from the `agent_execute` `completed` WS handler
 * so the chat bubble appears immediately when the run finishes; without
 * this, there's a visible gap between the iteration stream unmounting and
 * the real server-side Quest arriving via the change-stream subscriber
 * (sometimes seconds). The actual server Quest will replace this entry once
 * it lands.
 */
export function appendReplyToLatestOptimisticBubble(
  queryClient: QueryClient,
  sessionId: string,
  reply: string,
  agentExecutionId?: string,
  mementoIds?: string[],
  creditsUsed?: number
): void {
  queryClient.setQueryData<SessionQuestPages>(['quests', 'session', sessionId], current => {
    if (!current?.pages) return current;
    // Find the latest empty-reply quest for the agent_execute optimistic
    // bubble (chat_completion's optimistic quest gets replaced via the
    // callback's replaceQueryData call, so by the time this runs only the
    // agent_execute bubble would still be empty).
    const pages = current.pages.map(page => {
      const idx = page.data.findIndex(q => q.replies && q.replies.length === 0 && !!q.prompt);
      if (idx < 0) return page;
      // Patch the reply AND link the originating execution so the
      // "Show reasoning" disclosure (gated on `agentExecutionId` in
      // MessageContent) appears immediately on completion; without this
      // the disclosure was invisible until the change-stream subscriber
      // delivered the server-side Quest with the field set, which meant
      // users had to refresh to revisit the trace.
      // mementoIds are included here so MementoIndicator renders immediately
      // without waiting for the change-stream to deliver the persisted Quest.
      // creditsUsed rides the same path so the credits chip appears on
      // completion instead of only after the change-stream Quest lands.
      const patched: IChatHistoryItemDocument = {
        ...page.data[idx],
        replies: [reply],
        updatedAt: new Date(),
        ...(agentExecutionId ? { agentExecutionId } : {}),
        ...(typeof creditsUsed === 'number' ? { creditsUsed } : {}),
        ...(mementoIds?.length
          ? {
              promptMeta: {
                ...page.data[idx].promptMeta,
                context: { ...page.data[idx].promptMeta?.context, mementoIds },
              },
            }
          : {}),
      };
      const data = [...page.data];
      data[idx] = patched;
      return { ...page, data };
    });
    return { ...current, pages };
  });
}

/**
 * Build the optimistic quest bubble shown immediately for a freshly sent prompt.
 * Shared so callers that pre-seed the quest cache (e.g. /opti createNewSession) use the
 * exact same id/shape; the later createOptimisticQuest then replaces it in place instead
 * of creating a duplicate.
 */
export function buildOptimisticQuest(sessionId: string, prompt: string): IChatHistoryItemDocument {
  return {
    id: `optimistic-quest-${sessionId}`,
    sessionId,
    type: 'message',
    prompt,
    replies: [],
    images: [],
    status: 'running',
    timestamp: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function createOptimisticQuest(
  queryClient: QueryClient,
  sessionId: string,
  prompt: string,
  callback: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>
) {
  const optimisticQuest = buildOptimisticQuest(sessionId, prompt);

  setOptimisticQueryData(queryClient, ['quests', 'session', sessionId], optimisticQuest);

  // Mark session as streaming EARLY, before the API call returns, so the
  // collection subscription (useSubscribeToSessionQuests) is suppressed during
  // the window between "API returns real quest" and "first WebSocket chunk
  // arrives". Without this, the subscriber-fanout service (which watches
  // MongoDB via change streams and pushes data_update messages over WebSocket)
  // delivers the new quest with empty replies, and useSubscribeToSessionQuests
  // writes it into React Query cache, overwriting the streaming data and
  // causing the streamed text to disappear.
  // See: useSubscribeToSessionQuests isStreaming guard in sessions.ts.
  useStreamingState.getState().startStreaming(sessionId);

  try {
    const data = await callback();
    replaceQueryData(queryClient, ['quests', 'session', sessionId], optimisticQuest.id, data.quest);
    if (data.session?.id && data.session.id !== sessionId) {
      replaceQueryData(queryClient, ['quests', 'session', data.session.id], optimisticQuest.id, data.quest);
      // Clean up old session streaming state and mark the real session as streaming
      useStreamingState.getState().resetStreaming(sessionId);
      useStreamingState.getState().startStreaming(data.session.id);
    }
    return data;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const failedQuest: IChatHistoryItemDocument = {
      ...optimisticQuest,
      status: 'done',
      replies: [`**Error:** ${errorMessage}`],
    };
    replaceQueryData(queryClient, ['quests', 'session', sessionId], optimisticQuest.id, failedQuest);
    // Reset streaming state on error so collection subscription resumes
    useStreamingState.getState().resetStreaming(sessionId);
    throw error;
  }
}

export async function updateOptimisticQuest(
  queryClient: QueryClient,
  questId: string,
  sessionId: string | undefined,
  updates: Partial<IChatHistoryItemDocument>,
  callback: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>
) {
  perfLogger.log('[Client] Updating optimistic quest:', questId, updates);

  // Mark session as streaming EARLY, before the API call, to suppress the
  // collection subscription during the race window (same pattern as createOptimisticQuest)
  if (sessionId) {
    useStreamingState.getState().startStreaming(sessionId);
  }

  try {
    const data = await callback();

    // If we didn't have sessionId upfront, mark streaming now (best effort)
    if (!sessionId) {
      useStreamingState.getState().startStreaming(data.quest.sessionId);
    }

    updateSingleQueryDataFast(queryClient, ['quests', 'session', data.quest.sessionId], 'write', data.quest, {
      keysAllowedToCreate: [],
    });

    return data;
  } catch (error) {
    // Reset streaming state on error so collection subscription resumes
    if (sessionId) {
      useStreamingState.getState().resetStreaming(sessionId);
    }

    const errorMessage = getErrorMessage(error);
    // Find all query keys that might contain this quest and update status to 'done'
    const queries = queryClient.getQueriesData<{ pages: { data: IChatHistoryItemDocument[] }[] }>({
      queryKey: ['quests', 'session'],
    });
    for (const [queryKey, queryData] of queries) {
      if (!queryData || !('pages' in queryData)) continue;
      const hasQuest = queryData.pages.some(page => page.data.some(q => q.id === questId));
      if (hasQuest) {
        const failedQuest: IChatHistoryItemDocument = {
          id: questId,
          sessionId: '',
          type: 'message',
          prompt: updates.prompt || '',
          status: 'done',
          replies: [`**Error:** ${errorMessage}`],
          timestamp: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        updateSingleQueryDataFast(queryClient, queryKey, 'write', failedQuest, {
          keysAllowedToCreate: [],
        });
      }
    }
    throw error;
  }
}

export const getModels = async (): Promise<ModelInfo[]> => {
  try {
    const response = await api.get('/api/models');
    return response.data.models;
  } catch (error: unknown) {
    const axiosError = error as AxiosError;
    perfLogger.log('[Client] Error fetching LLM models:', axiosError);
    throw new Error('Failed to fetch LLM models: ' + axiosError.message);
  }
};

export type SendMessageOptions = {
  isRetry?: boolean;
  isImageEdit?: boolean;
  isVariation?: boolean;
  image?: string; // Image to be edited
};
