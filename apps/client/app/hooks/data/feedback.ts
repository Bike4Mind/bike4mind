import { useQuery } from '@tanstack/react-query';
import { FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';
import { getFeedbackFromServer, getFeedbackRollupFromServer } from '@client/app/utils/feedbackAPICalls';
import { useUser } from '@client/app/contexts/UserContext';
import { isOptimisticId } from '@client/app/utils/llm';

/**
 * Cache key for the session-scoped feedback read. Exported so the post-submit invalidation in
 * MessageContent builds the same key rather than re-spelling it. `userId` is part of the key, not
 * just the request: the read is per-caller, so a key without it would serve one account's
 * annotations to the next account signed in on the same tab.
 */
export const feedbackSessionQueryKey = (sessionId: string, userId: string | undefined) =>
  ['feedback', 'session', sessionId, userId] as const;

/**
 * Session-scoped feedback reads that back the in-thread "Reported" annotation on
 * `MessageContent`. Filtered to `subject: 'turn'` so it only returns per-message reports - never
 * session- or product-level feedback - and capped at FEEDBACK_LIST_MAX_LIMIT since a single
 * session is expected to carry at most a handful of reports, never enough to paginate.
 *
 * `userId` is sent explicitly and is NOT redundant with the endpoint's CASL scope: an admin holds
 * an unconditional `read` grant on FeedbackModel (`server/auth/ability.ts`), so for them the CASL
 * clause narrows to `{}` and an unfiltered session read would return OTHER users' reports - which
 * this annotation would then render as "You reported this message", carrying that reporter's
 * content and identity with it. The filter is what makes this a read of "did I report this turn".
 * Same reason `memoryV2.ts` keys its principal-scoped read on the user id.
 *
 * Every message rendered in a session calls this with the same `sessionId`; react-query dedupes
 * identical query keys to one request, the same pattern `useGetQuest`/`useModelInfo` already rely
 * on when called once per message.
 */
export function useGetFeedbackBySessionId(sessionId: string, options: { enabled?: boolean } = {}) {
  const { currentUser } = useUser();
  const userId = currentUser?.id;

  return useQuery({
    queryKey: feedbackSessionQueryKey(sessionId, userId),
    queryFn: async () => {
      // Guard rather than an optional param: omitting `userId` does not narrow to nothing, it
      // widens to every report the caller can read. Fail loudly instead of silently broadening.
      if (!userId) throw new Error('Session feedback read requires an authenticated user');

      const response = await getFeedbackFromServer({
        userId,
        sessionId,
        subject: 'turn',
        sort: 'desc',
        page: 1,
        limit: FEEDBACK_LIST_MAX_LIMIT,
      });
      return response.items;
    },
    staleTime: 1000 * 30,
    enabled: (options.enabled ?? true) && Boolean(userId) && !isOptimisticId(sessionId),
  });
}

/**
 * Cache key for the personal rollup read. `userId` is in the key for the same reason as the
 * session read above: the endpoint answers "my counts", so a key without it would serve one
 * account's totals to the next account signed in on the same tab.
 */
export const feedbackRollupQueryKey = (userId: string | undefined, from: string | undefined, to: string | undefined) =>
  ['feedback', 'rollup', userId, from, to] as const;

/**
 * Counts of the signed-in user's own reports over `[from, to)`. The bounds arrive already resolved
 * from the route's `validateSearch` (see `utils/feedbackRollupWindow.ts`) - this hook must never
 * default them itself, because a default computed per render churns the query key and refetches
 * without end.
 *
 * `undefined` checks rather than truthiness: an empty bound string is a malformed window the server
 * should reject with a 422, not a reason to fall through to an unbounded read.
 */
export function useFeedbackRollup({ from, to }: { from?: string; to?: string }) {
  const { currentUser } = useUser();
  const userId = currentUser?.id;

  return useQuery({
    queryKey: feedbackRollupQueryKey(userId, from, to),
    queryFn: async () => {
      if (!userId) throw new Error('Feedback rollup requires an authenticated user');
      if (from === undefined || to === undefined) throw new Error('Feedback rollup requires both window bounds');

      return getFeedbackRollupFromServer({ from, to });
    },
    staleTime: 1000 * 60,
    enabled: Boolean(userId) && from !== undefined && to !== undefined,
  });
}
