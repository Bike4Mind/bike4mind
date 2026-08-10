import type {
  IDataLakeDocument,
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { recomputeLakeStats } from './recomputeLakeStats';
import { lakeMembershipScope } from './lakeMembershipScope';
import { warnOnPrefixCollision } from './tagPrefixCollision';
import { bestEffortIndexRemove, type RetrievalIndexPort } from './ports';

interface ArchiveDataLakeAdapters {
  db: {
    dataLakes: Pick<
      IDataLakeRepository,
      'findById' | 'update' | 'setStats' | 'activateIfDraft' | 'find' | 'claimFilesArchivedAt'
    >;
    batches: Pick<IDataLakeBatchRepository, 'findActiveByDataLakeId' | 'markTerminalIfActive'>;
    fabFiles: Pick<IFabFileRepository, 'archiveByDataLakeTag' | 'computeDataLakeStats' | 'findIdsByDataLakeTag'>;
  };
  retrievalIndex?: RetrievalIndexPort;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Reversibly archives a data lake: cancels any in-flight batch first (so no counter
 * increment races the teardown), soft-hides the lake's files via an archived marker,
 * best-effort removes them from the retrieval index, then recomputes lake stats.
 * Owner or admin only. Uses transitional 'archiving' state for crash visibility.
 */
export const archiveDataLake = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  { db, retrievalIndex, logger }: ArchiveDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }

  if (!actor.isAdmin && existing.createdByUserId !== actor.userId) {
    throw new BadRequestError('Only the creator can archive this data lake');
  }

  // Only short-circuit on the terminal state. A lake left in the transitional
  // 'archiving' state by a crashed/timed-out prior attempt must be able to re-run -
  // the side effects below (cancel batches, archive files, recompute) are idempotent.
  if (existing.status === 'archived') {
    return existing;
  }

  // Step 1: quiesce in-flight batches so no increment races the teardown.
  const activeBatches = await db.batches.findActiveByDataLakeId(dataLakeId);
  await Promise.all(activeBatches.map(b => db.batches.markTerminalIfActive(b.id, 'cancelled')));

  // The stamp this sweep keys its batch to (see IDataLake.filesArchivedAt), so a later
  // archive->delete->restore can clear exactly these rows' archive marker. Skipped when a lake is
  // already sitting in 'archiving' with no mark: a re-run may have already stamped SOME rows with
  // an earlier, un-recorded archivedAt (archiveByDataLakeTag only ever touches archivedAt: null
  // rows), so claiming a fresh stamp now would name a batch narrower than what is actually
  // archived, stranding the rest. Unmarked archives unbounded instead, same fallback deleteDataLake
  // uses for filesDeletedAt.
  const preMarkSweepInFlight = existing.status === 'archiving' && !existing.filesArchivedAt;
  let stamp: Date | undefined;
  if (!preMarkSweepInFlight) {
    stamp = (await db.dataLakes.claimFilesArchivedAt(dataLakeId, new Date())) ?? undefined;
    if (!stamp) {
      logger?.warn('[dataLakes] archive recorded no stamp; this lake will restore-clear unbounded', {
        dataLakeId,
      });
    }
  }

  // Step 2: transitional state (crash-visible).
  await db.dataLakes.update({ id: dataLakeId, status: 'archiving' });

  // Step 3: soft-hide files + best-effort index removal. The scope covers prefix-tagged
  // members too, so a file that never got the meta-tag no longer stays browsable here.
  // Archive hides files, so a colliding sibling lake loses its prefix-tagged files from every
  // browse (they filter archivedAt: null) - and unarchiving either lake brings back BOTH lakes'
  // archived files, since the flip matches on archivedAt alone.
  await warnOnPrefixCollision(db, existing, logger);
  const scope = lakeMembershipScope(existing);
  await db.fabFiles.archiveByDataLakeTag(scope, stamp);
  // Same scope the sweep ran on. findIdsByDataLakeTag is the id source rather than the flip's
  // count because it reports every member whatever its archived/deleted state, so a re-run after
  // a crashed attempt still hands the index the full set.
  await bestEffortIndexRemove(retrievalIndex, scope, () => db.fabFiles.findIdsByDataLakeTag(scope), logger);

  // Step 4: settle to archived and reconcile stats from source (now 0 live files).
  const updated = await db.dataLakes.update({ id: dataLakeId, status: 'archived' });
  if (!updated) {
    throw new NotFoundError('Data lake not found after archive');
  }
  await recomputeLakeStats(existing, { db });

  return updated;
};
