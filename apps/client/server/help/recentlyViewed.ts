/**
 * Shared logic for the "recently viewed" help articles feature.
 *
 * Reuses the existing `HelpEventModel` `article_view` events (already recorded per user by
 * `useHelpAnalytics`) rather than introducing a new per-user store. The aggregation shape is
 * extracted here so it can be unit-tested without a database - the API route stays a thin wrapper.
 */
import type { PipelineStage } from 'mongoose';

/** Max distinct recently-viewed articles surfaced in the Help Center. */
export const MAX_RECENTLY_VIEWED = 8;

export interface RecentlyViewedArticle {
  slug: string;
  articleTitle?: string;
  viewedAt: Date;
}

/**
 * Build the aggregation pipeline that returns a user's most recently viewed help articles,
 * de-duplicated by slug (keeping the latest view of each), newest first. `limit` is clamped to
 * `[1, MAX_RECENTLY_VIEWED]` so a caller can never request an unbounded or empty result set.
 */
export function buildRecentlyViewedPipeline(userId: string, limit: number = MAX_RECENTLY_VIEWED): PipelineStage[] {
  const safeLimit = Math.max(1, Math.min(limit, MAX_RECENTLY_VIEWED));
  return [
    { $match: { type: 'article_view', userId, slug: { $nin: [null, ''] } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$slug',
        slug: { $first: '$slug' },
        articleTitle: { $first: '$articleTitle' },
        viewedAt: { $first: '$createdAt' },
      },
    },
    { $sort: { viewedAt: -1 } },
    { $limit: safeLimit },
    { $project: { _id: 0, slug: 1, articleTitle: 1, viewedAt: 1 } },
  ];
}
