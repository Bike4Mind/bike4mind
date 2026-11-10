import { FeedbackModel } from '@bike4mind/database';
import { FeedbackStatus, FeedbackType, WAITLIST_FEEDBACK_TAG } from '@bike4mind/common';

/**
 * The New feedback rows triage has nothing to act on, shared by the close-feedback-triage-noise
 * migration and its read-only preview so the preview counts exactly what the migration closes.
 * Mirrors `isFeedbackTriageNoise` (@bike4mind/common), which the create handler applies to new rows.
 *
 * "No comment" here means no text was ever stored: `contentStored` is not true (a true value whose
 * text has since expired under the 90-day TTL still had a comment) and no legacy inline `content`.
 * The create handler sees the raw body instead, so the one row the two disagree on is a comment
 * whose text write failed: kept New on create, closed here. Stored rows cannot tell that case apart.
 */
export const TRIAGE_NOISE_FILTERS = {
  waitlistSignups: { status: FeedbackStatus.New, tags: WAITLIST_FEEDBACK_TAG, type: null },
  bareThumbsUps: {
    status: FeedbackStatus.New,
    type: FeedbackType.THUMBS_UP,
    contentStored: { $ne: true },
    content: { $not: /\S/ },
  },
} as const;

export type TriageNoiseCategory = keyof typeof TRIAGE_NOISE_FILTERS;

export const TRIAGE_NOISE_CATEGORIES = Object.keys(TRIAGE_NOISE_FILTERS) as TriageNoiseCategory[];

export async function countTriageNoise(since?: Date): Promise<Record<TriageNoiseCategory, number>> {
  const counts = await Promise.all(
    TRIAGE_NOISE_CATEGORIES.map(category =>
      FeedbackModel.collection.countDocuments({
        ...TRIAGE_NOISE_FILTERS[category],
        ...(since && { createdAt: { $gte: since } }),
      })
    )
  );
  return Object.fromEntries(TRIAGE_NOISE_CATEGORIES.map((category, i) => [category, counts[i]])) as Record<
    TriageNoiseCategory,
    number
  >;
}

export async function closeTriageNoise(): Promise<Record<TriageNoiseCategory, number>> {
  const closed = {} as Record<TriageNoiseCategory, number>;
  for (const category of TRIAGE_NOISE_CATEGORIES) {
    const result = await FeedbackModel.collection.updateMany(TRIAGE_NOISE_FILTERS[category], {
      $set: { status: FeedbackStatus.Closed, updatedAt: new Date() },
    });
    closed[category] = result.modifiedCount;
  }
  return closed;
}
