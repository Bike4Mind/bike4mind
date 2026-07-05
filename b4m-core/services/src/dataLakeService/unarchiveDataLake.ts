import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { recomputeLakeStats } from './recomputeLakeStats';

export interface UnarchiveResult {
  restoredCount: number;
  skippedDuplicates: number;
}

interface UnarchiveDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update' | 'setStats'>;
    fabFiles: Pick<
      IFabFileRepository,
      | 'findArchivedByDataLakeTag'
      | 'findByContentHashesInDataLake'
      | 'unarchiveByDataLakeTag'
      | 'deleteManyInIds'
      | 'computeDataLakeStats'
    >;
  };
}

/**
 * Restores an archived data lake with a dedup pass: if a file was re-uploaded while
 * the lake was archived, the live copy wins and the archived duplicate is discarded
 * (not restored). Owner or admin only. Uses transitional 'restoring' state.
 */
export const unarchiveDataLake = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  { db }: UnarchiveDataLakeAdapters
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
  if (existing.status !== 'archived' && existing.status !== 'restoring') {
    throw new BadRequestError(`Cannot restore a data lake in '${existing.status}' status`);
  }

  await db.dataLakes.update({ id: dataLakeId, status: 'restoring' });

  // Dedup pass: a LIVE (non-archived, non-deleted) file with the same hash means the
  // file was re-uploaded while archived - the live copy wins.
  const archived = await db.fabFiles.findArchivedByDataLakeTag(existing.datalakeTag);
  const archivedHashes = archived.map(f => f.contentHash).filter((h): h is string => !!h);

  let skippedDuplicates = 0;
  if (archivedHashes.length > 0) {
    const live = await db.fabFiles.findByContentHashesInDataLake(archivedHashes, existing.datalakeTag);
    const liveHashes = new Set(live.map(f => f.contentHash));
    const duplicateIds = archived.filter(f => f.contentHash && liveHashes.has(f.contentHash)).map(f => f.id);
    if (duplicateIds.length > 0) {
      await db.fabFiles.deleteManyInIds(duplicateIds);
      skippedDuplicates = duplicateIds.length;
    }
  }

  // Restore the remaining archived files (the non-duplicates).
  const restoredCount = await db.fabFiles.unarchiveByDataLakeTag(existing.datalakeTag);

  await db.dataLakes.update({ id: dataLakeId, status: 'active' });
  await recomputeLakeStats(dataLakeId, existing.datalakeTag, { db });

  return { restoredCount, skippedDuplicates };
};
