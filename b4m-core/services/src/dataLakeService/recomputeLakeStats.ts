import type { IDataLakeDocument, IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { lakeMembershipScope } from './lakeMembershipScope';

export interface RecomputeLakeStatsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'setStats' | 'activateIfDraft'>;
    fabFiles: Pick<IFabFileRepository, 'computeDataLakeStats'>;
  };
}

/**
 * Recomputes a lake's authoritative fileCount/totalSizeBytes from the SOURCE file records and
 * persists them - never from running batch counters. Called at batch completion, on the reconcile
 * read path, and by every door that changes a file's membership, so transient counter drift
 * self-heals.
 *
 * Takes the lake document rather than an id + tag so the membership scope is derived here, and
 * every caller reaches it. That matters most at batch completion, the busiest writer of
 * fileCount: a caller left on a narrower scope would write a different count than the lifecycle
 * paths, and the stored value would flip depending on which one ran last.
 *
 * Also carries the draft -> active transition, because a lake with members is by definition no
 * longer a draft and this is where the membership doors converge (see
 * `recomputeStatsForLakeTags` for the file-write ones). Sitting on the doors instead, it reached
 * only the upload wizard, which is why a lake filled any other way never got to Discover.
 *
 * `skipActivation` lets a caller keep fileCount/totalSizeBytes accurate without risking the
 * publish side effect - for a prefix-arm join, membership itself is granted automatically (the
 * read-side predicate has no permission check), but activating a draft lake is a one-way,
 * visibility-changing action. This function does no authorization itself; a caller that cannot
 * establish the actor manages the lake (see canManageLake in toggleTags.ts/reconcileLakeTags.ts)
 * passes `skipActivation: true` rather than choosing between publishing to an unauthorized actor
 * or leaving stats stale indefinitely.
 */
export const recomputeLakeStats = async (
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  { db }: RecomputeLakeStatsAdapters,
  opts?: { skipActivation?: boolean }
): Promise<{ fileCount: number; totalSizeBytes: number; totalChunkedChars: number }> => {
  const stats = await db.fabFiles.computeDataLakeStats(lakeMembershipScope(lake));
  await db.dataLakes.setStats(lake.id, stats);
  // Emptying a lake never sends it back to draft - the transition is one-way, so a lake the owner
  // has already published stays published while they swap its contents.
  if (!opts?.skipActivation && stats.fileCount > 0) await db.dataLakes.activateIfDraft(lake.id);
  return stats;
};
