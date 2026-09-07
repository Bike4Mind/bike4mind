import type { IDataLakeBatchSummary, TaxonomyStatus } from '@bike4mind/common';

/**
 * Which taxonomy phase wins the one per-lake chip slot, most-actionable first, and - since
 * eligibility is membership in this array - which phases can hold the slot at all. Only 'ready'
 * and 'failed' open the review panel, so they outrank every in-progress phase;
 * 'analyzing'/'queued' at least render the progress indicator; 'applying' renders in no consumer
 * gate at all (ManagerNav, LakeInfoPanel), so it ranks last rather than hiding a sibling that
 * would show something. Must stay a permutation of TAXONOMY_ATTENTION_STATUSES - taxonomySlot.test.ts
 * asserts every pairwise relation here and that each attention status stays eligible.
 */
const SLOT_PRIORITY: readonly TaxonomyStatus[] = ['ready', 'failed', 'analyzing', 'queued', 'applying'];

/** -1 for any status outside SLOT_PRIORITY ('none', 'applied', 'dismissed', unset). */
const rankOf = (batch: IDataLakeBatchSummary): number =>
  batch.taxonomyStatus ? SLOT_PRIORITY.indexOf(batch.taxonomyStatus) : -1;

/**
 * Total order: rank, then id ascending. Equal rank means an identical taxonomyStatus and so an
 * identical rendered chip, leaving only "which id does the chip hand to onReviewTaxonomy" to
 * settle - and it has to settle the same way on every 10s poll. Both keys are immutable, so the
 * winner cannot change while the batches merely ingest. Deliberately NOT `updatedAt`: ingest
 * bumps it per file (incrementCounters, DataLakeModel) on a clock independent of taxonomy, so
 * two 'ready' siblings would trade the slot between polls. Id ascending is oldest-first among
 * equals, ObjectIds being creation-ordered.
 */
const outranks = (candidate: IDataLakeBatchSummary, held: IDataLakeBatchSummary): boolean => {
  const byRank = rankOf(candidate) - rankOf(held);
  return byRank !== 0 ? byRank < 0 : candidate.id < held.id;
};

/**
 * One batch per lake for the manager's taxonomy chip: the batch that most needs the user, not
 * the first one the list happens to carry. The batches list interleaves two server finders
 * (see pages/api/data-lakes/batches/index.ts) and every ingest-active batch precedes every
 * taxonomy-attention one, so arrival order routinely puts a batch with a terminal taxonomy
 * phase - still chunking, hence still in the list - ahead of a sibling awaiting review.
 * A lake with no eligible batch just misses the map entry, which every consumer already
 * treats the same as "nothing to show."
 *
 * Returns a prebuilt Map because the sidebar looks a lake up per row (ManagerNav): one pass
 * over the batch list, not a filter/find on every row of every render.
 */
export function selectTaxonomyBatchByLakeId(
  batches: readonly IDataLakeBatchSummary[] | undefined
): Map<string, IDataLakeBatchSummary> {
  const map = new Map<string, IDataLakeBatchSummary>();
  for (const batch of batches ?? []) {
    if (rankOf(batch) < 0) continue;
    const held = map.get(batch.dataLakeId);
    if (!held || outranks(batch, held)) map.set(batch.dataLakeId, batch);
  }
  return map;
}
