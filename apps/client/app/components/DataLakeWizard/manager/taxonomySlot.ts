import type { IDataLakeBatchSummary, TaxonomyStatus } from '@bike4mind/common';

/**
 * Which taxonomy phase wins the one per-lake chip slot, most-actionable first. Only 'ready' and
 * 'failed' open the review panel, so they outrank every in-progress phase; 'analyzing'/'queued'
 * at least render the progress indicator; 'applying' renders in no consumer gate at all
 * (ManagerNav, LakeInfoPanel), so it ranks last rather than hiding a sibling that would show
 * something. Must stay a permutation of TAXONOMY_ATTENTION_STATUSES - taxonomySlot.test.ts
 * asserts it, and membership in this array is also what makes a batch eligible at all.
 */
export const SLOT_PRIORITY: TaxonomyStatus[] = ['ready', 'failed', 'analyzing', 'queued', 'applying'];

/** -1 for any status outside SLOT_PRIORITY ('none', 'applied', 'dismissed', unset), which is
 *  also the "not eligible for the slot" signal. */
const rankOf = (batch: IDataLakeBatchSummary): number =>
  batch.taxonomyStatus ? SLOT_PRIORITY.indexOf(batch.taxonomyStatus) : -1;

/** JSON hands back an ISO string here despite the `Date` on IDataLakeBatchSummary (the list
 *  query does no date revival), so go through Date() rather than calling .getTime() on the
 *  field. A missing/unparseable value collapses to 0 so the ordering stays total. */
const updatedAtMs = (batch: IDataLakeBatchSummary): number => {
  const ms = new Date(batch.updatedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

/** Deterministic total order, so the slot cannot swap between 10s polls and change the id the
 *  chip hands to onReviewTaxonomy mid-review. The ingest half of the batches list has no
 *  server-side sort, so arrival order is not a usable tie-break. */
const outranks = (candidate: IDataLakeBatchSummary, held: IDataLakeBatchSummary): boolean => {
  const byRank = rankOf(candidate) - rankOf(held);
  if (byRank !== 0) return byRank < 0;
  const byUpdated = updatedAtMs(held) - updatedAtMs(candidate);
  if (byUpdated !== 0) return byUpdated < 0;
  return candidate.id < held.id;
};

/**
 * One batch per lake for the manager's taxonomy chip: the batch that most needs the user, not
 * the first one the list happens to carry. The batches list interleaves two server finders
 * (see pages/api/data-lakes/batches/index.ts) and every ingest-active batch precedes every
 * taxonomy-attention one, so arrival order routinely puts a batch with a terminal taxonomy
 * phase - still chunking, hence still in the list - ahead of a sibling awaiting review.
 * A lake with no eligible batch just misses the map entry, which every consumer already
 * treats the same as "nothing to show."
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
