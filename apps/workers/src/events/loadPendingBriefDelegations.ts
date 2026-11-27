import { BRIEF_LIMITS } from '@bike4mind/common';
import { delegatedItemRepository } from '@bike4mind/database';

/** An item pending this long lost its event; failing it keeps it from showing as in progress on every brief. */
export const DELEGATION_STALE_MS = 60 * 60 * 1000;

/** Unbriefed items survive failed briefs and section caps; three sections' worth covers every place one can land. */
export async function loadPendingBriefDelegations(userId: string, end: Date, now: Date, since?: Date) {
  await delegatedItemRepository.failStale(userId, new Date(now.getTime() - DELEGATION_STALE_MS), now);
  return delegatedItemRepository.listUnbriefed(userId, end, BRIEF_LIMITS.itemsPerSection * 3, since);
}
