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
    fabFiles: Pick<
      IFabFileRepository,
      'archiveByDataLakeTag' | 'computeDataLakeStats' | 'findIdsByDataLakeTag' | 'hasArchivedByDataLakeTag'
    >;
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

  const scope = lakeMembershipScope(existing);

  // The stamp this sweep keys its batch to (see IDataLake.filesArchivedAt), so a later
  // archive->delete->restore can clear exactly these rows' archive marker. Skipped whenever the
  // lake carries no mark AND already has archived members with no stamp - a lake archived before
  // this field existed, or (rarer) a crashed prior attempt whose claim landed but whose sweep
  // never ran, self-heals on its own via the claimed-value-echoed-back path below. Claiming a
  // FRESH stamp here would name a batch narrower than what is actually archived: the sweep only
  // ever touches archivedAt: null rows, so the pre-existing ones would never get the new stamp,
  // and the lake would end up with a filesArchivedAt that names zero rows - poisoning every future
  // restore into believing archivedAt is bounded when nothing on this lake actually carries the
  // mark. Archiving unstamped instead leaves those rows exactly as unrecoverable as they already
  // were, which is the safe direction to fail in.
  //
  // Also wider than the legacy case: the scope-matched query can't tell "pre-field legacy" apart
  // from "a prefix-sharing sibling's own stamp", so either one skips the claim here - and with it,
  // any freshly-archived rows this same sweep is about to write. Such a lake stays broken on
  // restore until someone archives it again (once nothing is left unstamped) and then unarchives
  // it - not "unarchive once" as a lake fresh out of restore is 'active', and unarchive only
  // accepts 'archived'/'restoring'. A known limitation, not a full fix for either case.
  const hasUnstampedArchive = !existing.filesArchivedAt && (await db.fabFiles.hasArchivedByDataLakeTag(scope));
  let stamp: Date | undefined;
  if (!hasUnstampedArchive) {
    stamp = (await db.dataLakes.claimFilesArchivedAt(dataLakeId, new Date())) ?? undefined;
    if (!stamp) {
      logger?.warn('[dataLakes] archive recorded no stamp; a later restore will not clear archivedAt for this lake', {
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
  const swept = await db.fabFiles.archiveByDataLakeTag(scope, stamp);
  // The probe-then-claim window above has no lock, so a concurrent archive on a prefix-colliding
  // sibling can stamp our row between the two and leave this sweep matching nothing: `stamp` gets
  // freshly claimed, but zero rows actually carry it. Clearing the mark in that case closes the
  // race regardless of how it arose - an empty lake also sweeps zero and clearing its
  // (already meaningless) mark is harmless.
  //
  // `!existing.filesArchivedAt` is load-bearing, not incidental: it's what tells a fresh claim
  // (the race above) apart from a crash re-entry that echoed an ALREADY-set stamp back (:81's
  // set-if-unset returns the existing value rather than minting one). A re-entry's sweep also
  // returns 0 - not because the batch was never written, but because every row already carries
  // this exact stamp from the completed attempt before the crash - and clearing it there would
  // strand every one of those rows on restore, reintroducing the bug this PR exists to fix.
  if (stamp && swept === 0 && !existing.filesArchivedAt) {
    await db.dataLakes.update({ id: dataLakeId, filesArchivedAt: null });
  }
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
