import type { IDataLakeDocument, IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { lakeMembershipScope } from './lakeMembershipScope';

export interface RecomputeLakeStatsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'setStats'>;
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
 */
export const recomputeLakeStats = async (
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  { db }: RecomputeLakeStatsAdapters
): Promise<{ fileCount: number; totalSizeBytes: number }> => {
  const stats = await db.fabFiles.computeDataLakeStats(lakeMembershipScope(lake));
  await db.dataLakes.setStats(lake.id, stats);
  return stats;
};
