/**
 * Schedule, thresholds, and CloudWatch series for the image moderation review sweep. Emitted by
 * apps/workers/src/cron/imageModerationReviewSweep.ts; the alarms in infra/imageModerationReviewAlarms.ts
 * watch them. Renaming a metric value starts a new CloudWatch series and orphans the history.
 */
export const IMAGE_MODERATION_REVIEW_NAMESPACE = 'Lumina5/ImageModerationReview';

export const IMAGE_MODERATION_REVIEW_METRICS = {
  OldestUnalertedAgeMinutes: 'OldestUnalertedAgeMinutes',
  OldestPendingAgeMinutes: 'OldestPendingAgeMinutes',
  PendingWithoutReviewers: 'PendingWithoutReviewers',
} as const;

export type ImageModerationReviewMetricName =
  (typeof IMAGE_MODERATION_REVIEW_METRICS)[keyof typeof IMAGE_MODERATION_REVIEW_METRICS];

export const REVIEW_SWEEP_INTERVAL_MINUTES = 15;
// An incident younger than this is left to the alert sent on the request that recorded it.
export const REVIEW_SWEEP_MIN_INCIDENT_AGE_MINUTES = 15;
export const REVIEW_REMINDER_INTERVAL_HOURS = 24;
export const UNALERTED_INCIDENT_ALARM_MINUTES = 30;
export const PENDING_INCIDENT_ALARM_MINUTES = 24 * 60;
