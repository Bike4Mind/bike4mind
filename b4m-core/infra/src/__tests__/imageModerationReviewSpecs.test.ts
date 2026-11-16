import { describe, it, expect } from 'vitest';
import {
  IMAGE_MODERATION_REVIEW_METRICS,
  IMAGE_MODERATION_REVIEW_NAMESPACE,
  PENDING_INCIDENT_ALARM_MINUTES,
  REVIEW_REMINDER_INTERVAL_HOURS,
  REVIEW_SWEEP_INTERVAL_MINUTES,
  REVIEW_SWEEP_MIN_INCIDENT_AGE_MINUTES,
  UNALERTED_INCIDENT_ALARM_MINUTES,
} from '../imageModerationReviewSpecs.js';

// Literals on purpose: a rename orphans the live CloudWatch series, and the cadence and alarm
// thresholds are an agreed contract that should not move without a test change.
describe('imageModerationReviewSpecs', () => {
  it('pins the namespace and metric names emitted to CloudWatch', () => {
    expect(IMAGE_MODERATION_REVIEW_NAMESPACE).toBe('Lumina5/ImageModerationReview');
    expect(IMAGE_MODERATION_REVIEW_METRICS).toEqual({
      OldestUnalertedAgeMinutes: 'OldestUnalertedAgeMinutes',
      OldestPendingAgeMinutes: 'OldestPendingAgeMinutes',
      PendingWithoutReviewers: 'PendingWithoutReviewers',
    });
  });

  it('pins the sweep cadence, grace period, reminder interval and alarm thresholds', () => {
    expect(REVIEW_SWEEP_INTERVAL_MINUTES).toBe(15);
    expect(REVIEW_SWEEP_MIN_INCIDENT_AGE_MINUTES).toBe(15);
    expect(REVIEW_REMINDER_INTERVAL_HOURS).toBe(24);
    expect(UNALERTED_INCIDENT_ALARM_MINUTES).toBe(30);
    expect(PENDING_INCIDENT_ALARM_MINUTES).toBe(1440);
  });
});
