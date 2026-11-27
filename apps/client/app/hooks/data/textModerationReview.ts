import { api } from '@client/app/contexts/ApiContext';
import type { ModerationReviewUser } from '@bike4mind/common';
import { useQuery } from '@tanstack/react-query';

const ENDPOINT = '/api/admin/moderation-review';

export const TEXT_MODERATION_REVIEW_QUERY_KEY = ['admin-text-moderation-review'];

/** ModerationReviewUser as it arrives over JSON: dates are ISO strings. */
export type TextModerationReviewRow = Omit<ModerationReviewUser, 'createdAt'> & { createdAt: string | null };

/** The text-prompt moderation review list (GET /api/admin/moderation-review). */
export function useTextModerationReview() {
  return useQuery({
    queryKey: TEXT_MODERATION_REVIEW_QUERY_KEY,
    queryFn: async () => (await api.get<{ users: TextModerationReviewRow[] }>(ENDPOINT)).data.users,
  });
}
