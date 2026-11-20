import { FeedbackModel } from '@bike4mind/database';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import {
  DAY_MS,
  emptyFeedbackTypeCounts,
  FEEDBACK_SHARE_WINDOW_DAYS,
  FEEDBACK_OPEN_STATUSES,
  FEEDBACK_TREND_DAYS,
  type FeedbackTrends,
} from '@client/app/components/admin/Feedback/feedbackTrends';

// Same bound as the other admin aggregates over a date range (e.g. pages/api/users/counterLogs.ts).
const FEEDBACK_TRENDS_MAX_TIME_MS = 45000;

export interface FeedbackTrendBucket {
  /** Whole days between the report and `now`: 0 is the last 24 hours. */
  daysAgo: number;
  type: string | null;
  count: number;
}

const KNOWN_TYPES = new Set<string>(Object.values(FeedbackType));

/** Folds the per-day, per-type counts into the response. Pure, so the arithmetic is testable without a database. */
export function buildFeedbackTrends(open: number, buckets: readonly FeedbackTrendBucket[], now: Date): FeedbackTrends {
  const daily = Array.from({ length: FEEDBACK_TREND_DAYS }, emptyFeedbackTypeCounts);
  let receivedLast24h = 0;
  let receivedLast30d = 0;
  const share = {
    current: { thumbsDown: 0, total: 0 },
    prior: { thumbsDown: 0, total: 0 },
  };

  for (const { daysAgo, type, count } of buckets) {
    // A createdAt slightly ahead of the server clock lands at -1; the list's `received` filter has no
    // upper bound and counts it, so it belongs to the latest day here too.
    const day = Math.max(0, daysAgo);
    if (day >= FEEDBACK_TREND_DAYS) continue;
    receivedLast30d += count;
    if (day === 0) receivedLast24h += count;

    // No type is Feedback, as GET /api/feedback's type filter reads it. An unknown legacy type matches
    // no type filter, so it counts toward totals only.
    const knownType = type === null ? FeedbackType.FEEDBACK : KNOWN_TYPES.has(type) ? (type as FeedbackType) : null;
    if (knownType) daily[FEEDBACK_TREND_DAYS - 1 - day][knownType] += count;

    const shareWindow =
      day < FEEDBACK_SHARE_WINDOW_DAYS ? share.current : day < FEEDBACK_SHARE_WINDOW_DAYS * 2 ? share.prior : null;
    if (shareWindow) {
      shareWindow.total += count;
      if (knownType === FeedbackType.THUMBS_DOWN) shareWindow.thumbsDown += count;
    }
  }

  return { open, receivedLast24h, receivedLast30d, thumbsDownShare: share, daily, asOf: now.toISOString() };
}

/**
 * Admin-wide feedback volume for the trend strip. Both reads walk `feedback_status_createdAt`: the
 * range read pins every status with `$in` so `createdAt` still bounds the scan, since DocumentDB has
 * no skip-scan to reach a second key without the first.
 */
export async function computeFeedbackTrends(now: Date = new Date()): Promise<FeedbackTrends> {
  const since = new Date(now.getTime() - FEEDBACK_TREND_DAYS * DAY_MS);

  const [open, buckets] = await Promise.all([
    FeedbackModel.countDocuments({ status: { $in: FEEDBACK_OPEN_STATUSES } })
      .maxTimeMS(FEEDBACK_TRENDS_MAX_TIME_MS)
      .exec(),
    FeedbackModel.aggregate<FeedbackTrendBucket>([
      { $match: { status: { $in: Object.values(FeedbackStatus) }, createdAt: { $gt: since } } },
      {
        $group: {
          _id: {
            daysAgo: { $floor: { $divide: [{ $subtract: [now, '$createdAt'] }, DAY_MS] } },
            type: { $ifNull: ['$type', null] },
          },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, daysAgo: '$_id.daysAgo', type: '$_id.type', count: 1 } },
    ])
      .option({ maxTimeMS: FEEDBACK_TRENDS_MAX_TIME_MS })
      .exec(),
  ]);

  return buildFeedbackTrends(open, buckets, now);
}
