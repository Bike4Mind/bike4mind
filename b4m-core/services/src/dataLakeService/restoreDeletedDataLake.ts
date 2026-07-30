import type { IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { recomputeLakeStats } from './recomputeLakeStats';
import { lakeMembershipScope } from './lakeMembershipScope';
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
 *
 * Known asymmetry: this un-deletes every member currently carrying deletedAt, not only the ones
 * phase 1 deleted, because nothing records which those were. So a member the creator had already
 * deleted on their own comes back with the lake. True for meta-tagged members before the prefix arm
 * existed; the arm widens the set to the creator's whole prefix namespace. Nothing is lost either
 * way - a file reappears rather than disappearing - and bounding it properly needs a recorded
 * teardown timestamp on the lake, which is not in this change's scope.
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
  const deleted = await db.fabFiles.findDeletedByDataLakeTag(scope);
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

  const restoredCount = await db.fabFiles.undeleteByDataLakeTag(scope, duplicateIds);

  await db.dataLakes.update({ id: dataLakeId, status: 'active' });
  await recomputeLakeStats(existing, { db });

  return { restoredCount, skippedDuplicates };
};
