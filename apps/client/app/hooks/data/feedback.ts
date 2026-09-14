import { useQuery } from '@tanstack/react-query';
import { FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';
import { getFeedbackFromServer } from '@client/app/utils/feedbackAPICalls';
import { isOptimisticId } from '@client/app/utils/llm';

/**
 * Session-scoped feedback reads that back the in-thread "Reported" annotation on
 * `MessageContent`. Filtered to `subject: 'turn'` so it only returns per-message reports - never
 * session- or product-level feedback - and capped at FEEDBACK_LIST_MAX_LIMIT since a single
 * session is expected to carry at most a handful of reports, never enough to paginate.
 *
 * The endpoint is CASL-scoped to the caller's own reports (see GET /api/feedback), so this is a
 * read of "did I report this turn", not a cross-user signal - nothing in the LLM/ChatCompletion
 * path reads this collection either way.
 *
 * Every message rendered in a session calls this with the same `sessionId`; react-query dedupes
 * identical query keys to one request, the same pattern `useGetQuest`/`useModelInfo` already rely
 * on when called once per message.
 */
export function useGetFeedbackBySessionId(sessionId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['feedback', 'session', sessionId],
    queryFn: async () => {
      const response = await getFeedbackFromServer({
        sessionId,
        subject: 'turn',
        sort: 'desc',
        page: 1,
        limit: FEEDBACK_LIST_MAX_LIMIT,
      });
      return response.items;
    },
    staleTime: 1000 * 30,
    enabled: (options.enabled ?? true) && !isOptimisticId(sessionId),
  });
}
