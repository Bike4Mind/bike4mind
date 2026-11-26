import { OverwatchRawEvent, OverwatchUserDay, OverwatchUserFirstSeen } from '@bike4mind/database';
import { erasurePseudonym } from '../privacy/erasureHash';

export interface ErasedProductAnalytics {
  events: number;
  userDays: number;
  firstSeen: number;
}

/**
 * Delete the analytics events and the daily-active and first-seen markers recorded under the
 * account's pseudonym, for every product: overlay products send the same pseudonym
 * (`emitProductEvent`). Null when no salt is configured, since nothing was recorded under one.
 */
export async function eraseProductAnalyticsEvents(userId: string): Promise<ErasedProductAnalytics | null> {
  // Lower-cased like erasureIdHash: the emitters pseudonymize the canonical lower-case ObjectId hex.
  const pseudonym = erasurePseudonym(userId.toLowerCase());
  if (!pseudonym) return null;
  const filter = { userId: pseudonym };
  const [events, userDays, firstSeen] = await Promise.all([
    OverwatchRawEvent.deleteMany(filter),
    OverwatchUserDay.deleteMany(filter),
    OverwatchUserFirstSeen.deleteMany(filter),
  ]);
  return { events: events.deletedCount, userDays: userDays.deletedCount, firstSeen: firstSeen.deletedCount };
}
