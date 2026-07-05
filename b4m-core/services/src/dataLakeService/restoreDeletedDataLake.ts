import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { recomputeLakeStats } from './recomputeLakeStats';
import type { UnarchiveResult } from './unarchiveDataLake';

interface RestoreDeletedDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update' | 'setStats'>;
    fabFiles: Pick<
      IFabFileRepository,
      'findDeletedByDataLakeTag' | 'findByContentHashesInDataLake' | 'undeleteByDataLakeTag' | 'computeDataLakeStats'
    >;
  };
}

/**
 * Recovers a soft-deleted (phase-1) data lake back to active, with a dedup pass: if a
 * file was re-uploaded while the lake was deleted, the live copy wins and the deleted
 * duplicate is left discarded (not un-deleted). Owner or admin only. Mirrors
 * unarchiveDataLake but on the deletedAt axis. Only valid from the 'deleted' state.
 */
export const restoreDeletedDataLake = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  { db }: RestoreDeletedDataLakeAdapters
): Promise<UnarchiveResult> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }
  if (!actor.isAdmin && existing.createdByUserId !== actor.userId) {
    throw new BadRequestError('Only the creator can restore this data lake');
  }
  // Allow re-entry from the transitional 'restoring' state so a crashed prior attempt
  // can be retried (the dedup + undelete + recompute below are idempotent).
  if (existing.status !== 'deleted' && existing.status !== 'restoring') {
    throw new BadRequestError(`Cannot restore a data lake in '${existing.status}' status`);
  }

  await db.dataLakes.update({ id: dataLakeId, status: 'restoring' });

  // Dedup: a LIVE (non-deleted, non-archived) file with the same hash means it was
  // re-uploaded while the lake was deleted - keep the live copy, leave the deleted
  // duplicate discarded (excluded from the un-delete).
  const deleted = await db.fabFiles.findDeletedByDataLakeTag(existing.datalakeTag);
  const deletedHashes = deleted.map(f => f.contentHash).filter((h): h is string => !!h);

  let skippedDuplicates = 0;
  let duplicateIds: string[] = [];
  if (deletedHashes.length > 0) {
    const live = await db.fabFiles.findByContentHashesInDataLake(deletedHashes, existing.datalakeTag);
    const liveHashes = new Set(live.map(f => f.contentHash));
    duplicateIds = deleted.filter(f => f.contentHash && liveHashes.has(f.contentHash)).map(f => f.id);
    skippedDuplicates = duplicateIds.length;
  }

  const restoredCount = await db.fabFiles.undeleteByDataLakeTag(existing.datalakeTag, duplicateIds);

  await db.dataLakes.update({ id: dataLakeId, status: 'active' });
  await recomputeLakeStats(dataLakeId, existing.datalakeTag, { db });

  return { restoredCount, skippedDuplicates };
};
