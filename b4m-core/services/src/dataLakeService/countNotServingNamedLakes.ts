import type { IDataLakeRepository } from '@bike4mind/common';

/**
 * How many of `missingTags` (lakes a session named by identity that did not make this turn's
 * scope) are drafts the caller created. Feeds the retrieval summary's `notServingLakes` (see
 * RetrievalSummarySchema in promptMeta.ts), which lets the answer diagnosis tell a draft-lake
 * abstain apart from a search that ran and found nothing.
 *
 * Only the caller's OWN drafts count: anyone can put a `datalake:` tag on a session, so counting
 * every draft would let that tag probe whether another user's draft exists. An active lake that is
 * missing (gated) is excludedLakes' business, not this one's.
 *
 * Returns undefined, never a guessed zero, when the lookup is not wired or throws - the field's
 * absent-means-not-measured contract.
 */
export async function countNotServingNamedLakes(
  dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag'> | undefined,
  userId: string | { toString(): string } | null | undefined,
  missingTags: string[],
  logger?: { warn(message: string): void }
): Promise<number | undefined> {
  if (missingTags.length === 0) return 0;
  // An id-less caller created nothing, so none of the missing lakes can be its draft.
  if (!userId) return 0;
  if (!dataLakes) return undefined;
  const callerId = String(userId);
  try {
    // One indexed point read per tag; a session names a handful of lakes at most.
    const lakes = await Promise.all(missingTags.map(tag => dataLakes.findByDatalakeTag(tag)));
    return lakes.filter(lake => lake?.status === 'draft' && String(lake.createdByUserId) === callerId).length;
  } catch (err) {
    logger?.warn(`[dataLakes] not-serving named lake count skipped; lookup failed: ${(err as Error)?.message}`);
    return undefined;
  }
}
