import { FeedbackModel } from '@bike4mind/database';
import { FeedbackStatus, WAITLIST_FEEDBACK_TAG } from '@bike4mind/common';

/**
 * Historical cleanup is limited to untyped waitlist signups. Existing thumbs-ups stay untouched:
 * missing or expired text cannot reliably distinguish an empty report from a lost comment.
 * Shared by the migration and its read-only preview so both select the same rows.
 */
export const TRIAGE_NOISE_FILTERS = {
  waitlistSignups: { status: FeedbackStatus.New, tags: WAITLIST_FEEDBACK_TAG, type: { $in: [null, ''] } },
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
