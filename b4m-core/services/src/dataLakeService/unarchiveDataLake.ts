import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { recomputeLakeStats } from './recomputeLakeStats';
import { lakeMembershipScope } from './lakeMembershipScope';

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
 *
 * Scoped to the batch archive recorded in `filesArchivedAt`, so a file the creator archived on
 * their own is neither un-archived here nor eligible for the dedup pass's hard delete. A lake
 * archived before that field existed has no mark and reverses unbounded, as it always did.
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

  const scope = lakeMembershipScope(existing);

  // Dedup pass: a LIVE (non-archived, non-deleted) file with the same hash means the
  // file was re-uploaded while archived - the live copy wins.
  // Bounded to the batch archive recorded. Load-bearing on this axis, not just tidiness: the loser
  // of the comparison below is HARD-deleted, so an unbounded read would nominate a file the creator
  // archived on their own for destruction the moment its contentHash collided with a live member.
  const stampedAt = existing.filesArchivedAt ?? undefined;
  const archived = await db.fabFiles.findArchivedByDataLakeTag(scope, stampedAt);
  const archivedHashes = archived.map(f => f.contentHash).filter((h): h is string => !!h);

  let skippedDuplicates = 0;
  if (archivedHashes.length > 0) {
    // Meta-tag only, NOT the membership scope: the loser of this comparison is hard-deleted
    // below, and fileTagPrefix is not unique, so a prefix match could nominate a live file
    // belonging to a DIFFERENT lake as the winner and destroy this lake's archived member.
    // Any re-upload worth deduping carries the meta-tag, so the narrow probe loses nothing;
    // at worst a prefix-only re-upload leaves a duplicate, which beats deleting the wrong file.
    const live = await db.fabFiles.findByContentHashesInDataLake(archivedHashes, existing.datalakeTag);
    const liveHashes = new Set(live.map(f => f.contentHash));
    const duplicateIds = archived.filter(f => f.contentHash && liveHashes.has(f.contentHash)).map(f => f.id);
    if (duplicateIds.length > 0) {
      await db.fabFiles.deleteManyInIds(duplicateIds);
      skippedDuplicates = duplicateIds.length;
    }
  }

  // Restore the remaining archived files (the non-duplicates).
  const restoredCount = await db.fabFiles.unarchiveByDataLakeTag(scope, stampedAt);

  // Explicit null, not undefined, which mongoose would drop and leave the spent mark in place.
  await db.dataLakes.update({ id: dataLakeId, status: 'active', filesArchivedAt: null });
  await recomputeLakeStats(existing, { db });

  return { restoredCount, skippedDuplicates };
};
