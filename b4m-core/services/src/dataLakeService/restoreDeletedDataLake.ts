import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { recomputeLakeStats } from './recomputeLakeStats';
import { lakeMembershipScope } from './lakeMembershipScope';
import type { UnarchiveResult } from './unarchiveDataLake';

interface RestoreDeletedDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update' | 'setStats' | 'activateIfDraft'>;
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
 *
 * Scoped to the batch phase 1 actually deleted, via the stamp it recorded in `filesDeletedAt`: a
 * member the creator deleted on their own - before the teardown or while the lake sat deleted -
 * carries a different stamp and stays deleted. A lake torn down before that field existed has no
 * mark and restores unbounded, which is the old behavior and errs toward a file reappearing.
 *
 * Also clears `archivedAt` on the restored batch, bounded by `filesArchivedAt`: every UI-driven
 * delete goes active -> archive -> delete (there is no delete-without-archiving control), so
 * without this an archive->delete->restore lake comes back active but with its files still
 * archived and invisible. A lake with no `filesArchivedAt` stamp leaves archivedAt untouched -
 * the pre-existing, known behavior for a lake archived before that field existed.
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
  const scope = lakeMembershipScope(existing);
  // The batch phase 1 recorded. undefined for a lake torn down before the mark existed, which keeps
  // the old unbounded reversal rather than restoring nothing.
  const stampedAt = existing.filesDeletedAt ?? undefined;
  const deleted = await db.fabFiles.findDeletedByDataLakeTag(scope, stampedAt);
  const deletedHashes = deleted.map(f => f.contentHash).filter((h): h is string => !!h);

  let skippedDuplicates = 0;
  let duplicateIds: string[] = [];
  if (deletedHashes.length > 0) {
    // Meta-tag only, matching the unarchive dedup: a non-unique fileTagPrefix must not let a
    // different lake's live file decide which of this lake's rows stays discarded.
    const live = await db.fabFiles.findByContentHashesInDataLake(deletedHashes, existing.datalakeTag);
    const liveHashes = new Set(live.map(f => f.contentHash));
    duplicateIds = deleted.filter(f => f.contentHash && liveHashes.has(f.contentHash)).map(f => f.id);
    skippedDuplicates = duplicateIds.length;
  }

  // The batch this lake's own archive recorded, if any. undefined for a lake with no mark
  // (archived before the field existed, or never archived), which leaves archivedAt untouched.
  const archiveStampToClear = existing.filesArchivedAt ?? undefined;
  const restoredCount = await db.fabFiles.undeleteByDataLakeTag(scope, duplicateIds, stampedAt, archiveStampToClear);

  // Explicit null, not undefined, which mongoose would drop and leave the spent mark in place.
  await db.dataLakes.update({ id: dataLakeId, status: 'active', filesDeletedAt: null, filesArchivedAt: null });
  await recomputeLakeStats(existing, { db });

  return { restoredCount, skippedDuplicates };
};
