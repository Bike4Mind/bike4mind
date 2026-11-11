import { FeedbackType } from '@bike4mind/common';

/**
 * React-free on purpose: GET /api/feedback (its `received` filter), GET /api/admin/feedback-trends
 * and the router's eager import of feedbackTabSearch.ts all read it.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the list's "Received" filter reaches, rolling from the moment of the request. */
export const FEEDBACK_RECEIVED_WINDOWS = ['24h', '7d', '30d'] as const;
export type FeedbackReceivedWindow = (typeof FEEDBACK_RECEIVED_WINDOWS)[number];

export const FEEDBACK_RECEIVED_WINDOW_DAYS: Record<FeedbackReceivedWindow, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

export const FEEDBACK_RECEIVED_LABELS: Record<FeedbackReceivedWindow, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/**
 * The exclusive lower bound on `createdAt` for a window. The trends endpoint buckets with the same
 * bound, and the strip refetches when a figure is clicked, so a figure and the list it opens are
 * computed moments apart over the same rule.
 */
export const feedbackReceivedSince = (range: FeedbackReceivedWindow, now: Date): Date =>
  new Date(now.getTime() - FEEDBACK_RECEIVED_WINDOW_DAYS[range] * DAY_MS);

/** Days the trend sparkline covers; also the widest received window. */
export const FEEDBACK_TREND_DAYS = 30;
/** Days in each half of the thumbs-down comparison. */
export const FEEDBACK_SHARE_WINDOW_DAYS = 7;

export type FeedbackTypeCounts = Record<FeedbackType, number>;

export interface FeedbackShareWindow {
  thumbsDown: number;
  total: number;
}

/** Response of GET /api/admin/feedback-trends. */
export interface FeedbackTrends {
  /** Reports in New or In progress, of any age. */
  open: number;
  receivedLast24h: number;
  /** Every report in `daily`'s span, including any with an unknown type that no type series counts. */
  receivedLast30d: number;
  thumbsDownShare: {
    /** The 7 days before `asOf`. */
    current: FeedbackShareWindow;
    /** The 7 days before those. */
    prior: FeedbackShareWindow;
  };
  /**
   * Rolling 24-hour days, oldest first; the last is the 24 hours before `asOf`. Reports with no type
   * count as Feedback, as the list's type filter treats them.
   */
  daily: FeedbackTypeCounts[];
  asOf: string;
}

export const emptyFeedbackTypeCounts = (): FeedbackTypeCounts => ({
  [FeedbackType.BUG]: 0,
  [FeedbackType.THUMBS_DOWN]: 0,
  [FeedbackType.FEEDBACK]: 0,
  [FeedbackType.THUMBS_UP]: 0,
});

export const sumFeedbackTypeCounts = (counts: FeedbackTypeCounts): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

/** Share as a whole percent, or undefined when the window has no reports to divide by. */
export const thumbsDownPercent = ({ thumbsDown, total }: FeedbackShareWindow): number | undefined =>
  total > 0 ? Math.round((thumbsDown / total) * 100) : undefined;
