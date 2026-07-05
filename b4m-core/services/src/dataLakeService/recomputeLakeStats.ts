import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';

export interface RecomputeLakeStatsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'setStats'>;
    fabFiles: Pick<IFabFileRepository, 'computeDataLakeStats'>;
  };
}

/**
 * Recomputes a lake's authoritative fileCount/totalSizeBytes from the SOURCE file
 * records (indexed aggregate) and persists them - never from running batch counters.
 * Called at batch completion and on the reconcile read path so transient counter
 * drift self-heals.
 */
export const recomputeLakeStats = async (
  lakeId: string,
  datalakeTag: string,
  { db }: RecomputeLakeStatsAdapters
): Promise<{ fileCount: number; totalSizeBytes: number }> => {
  const stats = await db.fabFiles.computeDataLakeStats(datalakeTag);
  await db.dataLakes.setStats(lakeId, stats);
  return stats;
};
