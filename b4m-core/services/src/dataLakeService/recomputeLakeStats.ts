import type {
  DataLakeMembershipScope,
  IDataLakeDocument,
  IDataLakeRepository,
  IFabFileRepository,
  IUserRepository,
} from '@bike4mind/common';
import { resolveLakeMembershipScope } from './lakeMembershipScope';

export interface RecomputeLakeStatsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'setStats'>;
    fabFiles: Pick<IFabFileRepository, 'computeDataLakeStats'>;
    users: Pick<IUserRepository, 'findById'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Recomputes a lake's authoritative fileCount/totalSizeBytes from the SOURCE file records and
 * persists them - never from running batch counters. Called at batch completion and on the
 * reconcile read path so transient counter drift self-heals.
 *
 * Takes the lake document rather than an id + tag so the membership scope is resolved in exactly
 * one place. Every caller must reach this, including batch completion: a caller left on a
 * narrower scope would write a different count than the lifecycle paths, and the stored value
 * would flip back and forth depending on which one ran last.
 *
 * `resolvedScope` lets a caller that already resolved one hand it over - the lifecycle services
 * resolve it for their own file query and would otherwise re-read the creator's user record here.
 */
export const recomputeLakeStats = async (
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  { db, logger }: RecomputeLakeStatsAdapters,
  resolvedScope?: DataLakeMembershipScope
): Promise<{ fileCount: number; totalSizeBytes: number }> => {
  const scope = resolvedScope ?? (await resolveLakeMembershipScope(lake, { db, logger }));
  const stats = await db.fabFiles.computeDataLakeStats(scope);
  await db.dataLakes.setStats(lake.id, stats);
  return stats;
};
