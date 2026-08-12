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
  // Scoped to the META-TAG arm alone, not the full scope: the full scope also matches a
  // prefix-sharing sibling's own already-archived row, and for the SECOND lake to archive in a
  // live collision that row is always present - checking the full scope would make that lake skip
  // claiming a stamp EVERY time, so it could never bound its own later unarchive and would keep
  // freeing the sibling's rows unbounded, the exact bug this whole fix exists to close. No other
  // lake's document can carry this lake's own tag (see buildDataLakeMembershipFilter), so this
  // check cannot get a false positive from a SIBLING's document. It is not immune to a false
  // positive on one of THIS lake's own documents, though: a document genuinely carrying this
  // lake's meta-tag can still be swept and stamped by a co-owning or prefix-sharing sibling
  // lake's OWN archive, either because that same document also carries a second lake's meta-tag
  // (addFileToLake has no exclusivity check), or because it independently satisfies a sibling's
  // prefix arm (its owner matches that sibling's creator and it carries a tag under that
  // sibling's prefix) - the sweep that stamps it runs on the sibling's OWN scope, which does not
  // care what else the document is tagged with. Either way this guard still trips (correctly
  // conservative: it cannot tell "genuinely mine, never archived" from "mine, but a sibling
  // archived it first"), a known limitation for these rarer, deliberate or coincidental
  // multi-membership cases rather than the ordinary single-arm prefix collision this scoping
  // closes.
  //
  // Trade-off worth naming: a lake whose OWN pre-existing unstamped archive is entirely
  // prefix-only (no meta-tagged member at all) no longer trips this guard either, so its next
  // archive claims a real stamp and those old prefix-only rows stop being reachable by the
  // (now-bounded) unbounded fallback once filesArchivedAt is no longer absent. Accepted
  // deliberately: that population is fixed and shrinking (only lakes archived before this field
  // existed), while the sibling-freeing bug this scoping closes is live for as long as prefix
  // collisions exist.
  const hasUnstampedArchive =
    !existing.filesArchivedAt && (await db.fabFiles.hasArchivedByDataLakeTag({ datalakeTag: existing.datalakeTag }));
  let stamp: Date | undefined;
  if (!hasUnstampedArchive) {
    const at = new Date();
    stamp = (await db.dataLakes.claimFilesArchivedAt(dataLakeId, at)) ?? undefined;
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
  // browse (they filter archivedAt: null) - unarchiving either lake now bounds its own reversal
  // to its own stamp, so it no longer brings back the other's (see unarchiveByDataLakeTag).
  await warnOnPrefixCollision(db, existing, logger);
  // Generated here rather than left to archiveByDataLakeTag's default: when `stamp` is undefined,
  // this row-level timestamp is orphaned (no lake will ever name it) even though it is a real
  // Date, and that decision should be visible at the call site rather than buried in the repo
  // method's fallback.
  const sweepStamp = stamp ?? new Date();
  await db.fabFiles.archiveByDataLakeTag(scope, sweepStamp);
  // A stamp is kept even when it names zero rows (an empty lake, or a concurrent sibling/same-lake
  // claim that swept the shared rows first) - NOT cleared back to null. A cleared stamp reads,
  // downstream, as "this lake predates filesArchivedAt", which makes unarchiveByDataLakeTag run
  // its reversal unbounded and free whatever a sibling or a co-owning lake legitimately holds
  // archived under its own stamp - exactly the bug this field exists to prevent. An orphaned stamp
  // that names nothing is the safe value here: a later unarchive bounded to it also matches
  // nothing, which is the correct outcome for a lake with nothing of its own to restore.
  // Same scope the sweep ran on. findIdsByDataLakeTag is the id source rather than the flip's
  // count because it reports every member whatever its archived/deleted state, so a re-run after
  // a crashed attempt still hands the index the full set.
  await bestEffortIndexRemove(retrievalIndex, scope, () => db.fabFiles.findIdsByDataLakeTag(scope), logger);

  // Step 4: settle to archived and reconcile stats from source (now 0 live files).
  const updated = await db.dataLakes.update({ id: dataLakeId, status: 'archived' });
  if (!updated) {
    throw new NotFoundError('Data lake not found after archive');
  }
  // Always recompute from source, never short-circuit on the sweep's own count ("it archived
  // nothing, so stats can't have changed") - a re-entry sweeps 0 for rows a PRIOR attempt already
  // archived, and those rows are exactly what this recompute needs to reflect.
  await recomputeLakeStats(existing, { db });

  return updated;
};
