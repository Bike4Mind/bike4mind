import type { IDataLakeBatchSummary, TaxonomyStatus } from '@bike4mind/common';

/**
 * Which taxonomy phase wins the one per-lake chip slot, most-actionable first, and - since
 * eligibility is membership in this array - which phases can hold the slot at all. Only 'ready'
 * and 'failed' open the review panel, so they outrank every in-progress phase;
 * 'analyzing'/'queued' at least render the progress indicator; 'applying' renders in no consumer
 * gate at all (ManagerNav, LakeInfoPanel), so it ranks last rather than hiding a sibling that
 * would show something. Accepted consequence of one chip per lake: a 'failed' batch's error and
 * its exits (re-analyze, dismiss) wait behind an unresolved 'ready' sibling - review is the more
 * valuable affordance and a failure is non-destructive - and surface once that sibling is applied
 * or dismissed and so leaves the attention set.
 *
 * Must stay a permutation of TAXONOMY_ATTENTION_STATUSES. taxonomySlot.test.ts pins the pairwise
 * relations among today's five statuses, that every attention status stays eligible, and that the
 * three TaxonomyStatus values outside the attention set stay out; those 5 + 3 exhaust the union
 * today, so a sixth attention status needs its own rows in that pairwise table.
 */
const SLOT_PRIORITY: readonly TaxonomyStatus[] = ['ready', 'failed', 'analyzing', 'queued', 'applying'];

/** -1 for any status outside SLOT_PRIORITY ('none', 'applied', 'dismissed', unset). */
const rankOf = (batch: IDataLakeBatchSummary): number =>
  batch.taxonomyStatus ? SLOT_PRIORITY.indexOf(batch.taxonomyStatus) : -1;

/**
 * Total order: rank, then id ascending. Equal rank means an identical taxonomyStatus and so an
 * identical rendered chip, leaving only "which id does the chip hand to onReviewTaxonomy" to
 * settle - and it has to settle the same way on every 10s poll. Neither key moves on an ingest
 * write, so the winner changes only when a taxonomy phase does. Deliberately NOT `updatedAt`: ingest
 * bumps it per file (incrementCounters, DataLakeModel) on a clock independent of taxonomy, so
 * two 'ready' siblings would trade the slot between polls. Id ascending only has to be
 * deterministic; it approximates oldest-first, an ObjectId's timestamp being whole-second.
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
