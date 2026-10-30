import { z } from 'zod';
import type { SignupSignal } from './signupSignals';

/**
 * The admin Analytics overview: query and response shared by the route
 * (pages/api/admin/analytics/overview.ts), its server module (server/analytics/analyticsOverview.ts)
 * and the page (components/admin/Analytics). Every day is a UTC `YYYY-MM-DD`.
 */
export const ANALYTICS_RANGES = ['7d', '28d', '90d', '12m', 'custom'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const ANALYTICS_COMPARE = ['prev', 'off'] as const;
export type AnalyticsCompare = (typeof ANALYTICS_COMPARE)[number];
export const ANALYTICS_SIGNUPS = ['legit', 'all'] as const;
export type AnalyticsSignupsMode = (typeof ANALYTICS_SIGNUPS)[number];

export const ANALYTICS_DEFAULTS = { range: '28d', compare: 'prev', signups: 'legit' } as const;

/** Longest custom range, in days: one year plus a leap day. */
export const ANALYTICS_MAX_CUSTOM_DAYS = 366;

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD.');

export const analyticsOverviewQuerySchema = z
  .object({
    range: z.enum(ANALYTICS_RANGES).default(ANALYTICS_DEFAULTS.range),
    from: dayString.optional(),
    to: dayString.optional(),
    compare: z.enum(ANALYTICS_COMPARE).default(ANALYTICS_DEFAULTS.compare),
    signups: z.enum(ANALYTICS_SIGNUPS).default(ANALYTICS_DEFAULTS.signups),
  })
  .refine(query => query.range !== 'custom' || (query.from && query.to), {
    message: 'A custom range needs both a start and an end date.',
    path: ['from'],
  });
export type AnalyticsOverviewQuery = z.infer<typeof analyticsOverviewQuerySchema>;

export type AnalyticsBucket = 'day' | 'week' | 'month';

/** A tile value over the range's complete days, and the same over the previous period when compare is on. */
export type AnalyticsStat = { value: number | null; previous: number | null };

export type ActiveUsersDay = {
  day: string;
  /** Null when the rollup row for the day is missing: drawn as a gap, never as zero. */
  dau: number | null;
  wau: number | null;
  mau: number | null;
  /** Today, computed live and still filling up. */
  partial: boolean;
  /** The same position in the previous period, when compare is on. */
  previousMau?: number | null;
};

export type RequestsBySourceDay = { day: string; partial: boolean; counts: Record<string, number> | null };

export type SignupBucket = {
  /** First UTC day of the bucket, clipped to the range. */
  start: string;
  /** Day after the bucket's last day, clipped to the range: [start, end). */
  end: string;
  legit: number | null;
  suspected: number | null;
  unclassified: number | null;
  partial: boolean;
};

export type AnalyticsOverview = {
  window: {
    range: AnalyticsRange;
    from: string;
    to: string;
    today: string;
    /** The range ends today, so its last day is partial and left out of every comparison. */
    partialDay: string | null;
    /** Complete days in the range: the span the tiles and comparisons cover. */
    completeDays: number;
    previous: { from: string; to: string } | null;
    bucket: AnalyticsBucket;
  };
  signupsMode: AnalyticsSignupsMode;
  /** Latest rollup computedAt among the rows read, ISO. */
  lastUpdated: string | null;
  /** lastUpdated is older than ANALYTICS_STALE_AFTER_MS, or there is no rollup at all. */
  stale: boolean;
  /** Complete days in the range with no rollup row. */
  missingDays: string[];
  stats: {
    mau: AnalyticsStat;
    avgDau: AnalyticsStat;
    /** Percent, 0 to 100. */
    stickiness: AnalyticsStat;
    newSignups: AnalyticsStat & { suspected: number | null };
  };
  activeUsers: { days: ActiveUsersDay[]; bySource: RequestsBySourceDay[]; sources: string[] };
  signups: {
    buckets: SignupBucket[];
    totals: { legit: number; suspected: number; unclassified: number };
    bySignal: { signal: SignupSignal | string; count: number }[];
  };
};

export const ANALYTICS_STALE_AFTER_MS = 30 * 60 * 60 * 1000;
