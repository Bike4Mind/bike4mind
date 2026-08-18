import type {
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake, type ManageActor } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';
import { recomputeLakeStats } from './recomputeLakeStats';
import { lakeMembershipScope } from './lakeMembershipScope';
import { warnOnPrefixCollision } from './tagPrefixCollision';
import { bestEffortIndexRemove, type RetrievalIndexPort } from './ports';

interface ArchiveDataLakeAdapters extends LakeConfigAuditAdapters {
  // The event repo is REQUIRED here, unlike the optional shape LakeConfigAuditAdapters carries
  // for recomputeLakeStats: every caller of this service is an API route (there is exactly one
  // per service), so nothing is spared by making it optional and a route that forgot to wire it
  // would go dark silently - the one failure mode an audit must not have. Required here turns
  // that into a compile error.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<
      IDataLakeRepository,
      'findById' | 'update' | 'setStats' | 'activateIfDraft' | 'find' | 'claimFilesArchivedAt'
    >;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    batches: Pick<IDataLakeBatchRepository, 'findActiveByDataLakeId' | 'markTerminalIfActive'>;
    fabFiles: Pick<
      IFabFileRepository,
      | 'archiveByDataLakeTag'
      | 'computeDataLakeStats'
      | 'findIdsByDataLakeTag'
      | 'hasArchivedMemberExclusiveToDataLakeTag'
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
  actor: ManageActor,
  dataLakeId: string,
  { db, retrievalIndex, logger }: ArchiveDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }

  // Loaded once and reused for the audit event's manage rung: the gate and the recorded rung must
  // agree on one grant set, not two reads that could disagree.
  const grants = await loadActiveLakeGrants(existing, { db });
  if (!canManageLake(existing, actor, grants)) {
    throw new BadRequestError('You do not have permission to archive this data lake');
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
  // Scoped to the META-TAG arm alone, not the full scope. The full scope also matches a
  // prefix-sharing sibling's own already-archived row, and for the SECOND lake to archive in a
  // live collision that row is always present, so checking the full scope would make that lake
  // skip claiming a stamp EVERY time; it could never bound its own later unarchive and would keep
  // freeing the sibling's rows unbounded, the exact bug this whole fix exists to close. No other
  // lake's document can carry this lake's own tag (see buildDataLakeMembershipFilter), so this
  // check cannot get a false positive from a SIBLING's document that only shares a prefix.
  //
  // It also excludes a document that carries a SECOND lake's meta-tag too: `addFileToLake` has no
  // exclusivity check, so one file can belong to more than one lake, and a co-tagged row already
  // archived under a co-owner's own stamp is that lake's, not this lake's un-restorable orphan.
  // Counting it here would make this lake skip claiming its own stamp forever and fall back to
  // the pre-fix unbounded restore on every one of ITS OWN future unarchive calls - see
  // `hasArchivedMemberExclusiveToDataLakeTag`'s own doc.
  //
  // What remains, and is NOT excluded: a document carrying ONLY this lake's meta-tag that a
  // prefix-sharing sibling's own sweep stamped because it independently satisfies that sibling's
  // prefix arm (same creator, a tag under that sibling's prefix). Nothing on the row records
  // which lake's sweep touched it, so this guard still trips there - conservatively, and
  // deliberately: a per-file lake-attribution marker doesn't exist today, and the precondition
  // (a same-creator prefix collision) is rare enough that adding one isn't justified. Tracked and
  // ratified as an accepted, disclosed limitation in #1729.
  //
  // Trade-off worth naming: a lake whose OWN pre-existing unstamped archive is entirely
  // prefix-only (no meta-tagged member at all), OR whose only leftover unstamped member also
  // carries a SECOND lake's meta-tag, no longer trips this guard either, so its next archive
  // claims a real stamp and that leftover row stops being reachable by the (now-bounded) unbounded
  // fallback once filesArchivedAt is no longer absent. For the co-tagged case this is only safe
  // when the co-owning lake can itself still restore that row (an ordinary lake, with its own
  // document, can); it is NOT safe for a leftover co-tagged with a hardcoded fallback/registry
  // "lake" that has no backing document at all (see the fallback-lake registry) - such a lake can
  // never run its own unarchive, so that row would go from "wrongly reachable by this lake's
  // unbounded fallback" to permanently unreachable by anyone. Accepted deliberately: both leftover
  // populations are fixed and shrinking (rows predating this field, or predating a since-tightened
  // membership rule), while the sibling-freeing bug this scoping closes is live for as long as
  // multi-membership or prefix collisions exist.
  const hasUnstampedArchive =
    !existing.filesArchivedAt &&
    (await db.fabFiles.hasArchivedMemberExclusiveToDataLakeTag({ datalakeTag: existing.datalakeTag }));
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
  // browse (they filter archivedAt: null). Unarchiving either lake now bounds its own reversal
  // to its own stamp, so it no longer brings back the other's (see unarchiveByDataLakeTag).
  await warnOnPrefixCollision(db, existing, logger);
  // Generated here rather than left to archiveByDataLakeTag's default: when `stamp` is undefined,
  // this row-level timestamp is orphaned (no lake will ever name it) even though it is a real
  // Date, and that decision should be visible at the call site rather than buried in the repo
  // method's fallback.
  const sweepStamp = stamp ?? new Date();
  await db.fabFiles.archiveByDataLakeTag(scope, sweepStamp);
  // A stamp is kept even when it names zero rows (an empty lake, or a concurrent sibling/same-lake
  // claim that swept the shared rows first), NOT cleared back to null. A cleared stamp reads,
  // downstream, as "this lake predates filesArchivedAt", which makes unarchiveByDataLakeTag run
  // its reversal unbounded and free whatever a sibling or a co-owning lake legitimately holds
  // archived under its own stamp, exactly the bug this field exists to prevent. An orphaned stamp
  // that names nothing is the safe value here: a later unarchive bounded to it also matches
  // nothing, which is the correct outcome for a lake with nothing of its own to restore.
  // Same scope the sweep ran on. findIdsByDataLakeTag is the id source rather than the flip's
  // count because it reports every member whatever its archived/deleted state, so a re-run after
  // a crashed attempt still hands the index the full set.
  await bestEffortIndexRemove(retrievalIndex, scope, () => db.fabFiles.findIdsByDataLakeTag(scope), logger);

  // Step 4: settle to archived and reconcile stats from source (now 0 live files).
  // Stamped on the TERMINAL transition only (not the 'archiving' hop above): one stamp per
  // operator action, so a crashed run that never settles leaves no half-record of an archive
  // that did not happen.
  const updated = await db.dataLakes.update({ id: dataLakeId, status: 'archived', ...lakeConfigWriteStamp(actor) });
  if (!updated) {
    throw new NotFoundError('Data lake not found after archive');
  }
  // Recorded on the terminal transition alongside the stamp, for the same reason and with the same
  // scope: one operator action, one audit row. Placed BEFORE the stats recompute so the archive is
  // attributed even if the recompute throws - the lake is already archived by this point either way.
  await recordLakeConfigChange(
    {
      actor,
      lake: existing,
      grants,
      action: 'archive',
      // Diffed against THIS write's own fields, never against `updated`: `BaseModel.update` is a
      // `findOneAndUpdate` returning the merged document, so a concurrent writer's `$set` landing in
      // the gap would be recorded under this caller's principal and rung. Same reasoning, and the
      // same fix, as `updateDataLake` - see its note. The field set here is fixed and small, so the
      // projection is exact rather than reconstructed.
      changes: diffLakeConfig(existing, { ...existing, status: 'archived' }),
    },
    { db, logger }
  );
  // Always recompute from source, never short-circuit on the sweep's own count ("it archived
  // nothing, so stats can't have changed"): a re-entry sweeps 0 for rows a PRIOR attempt already
  // archived, and those rows are exactly what this recompute needs to reflect.
  // Logger forwarded for parity with every other recompute call, not because an audit row is
  // expected here: this runs AFTER the status move, which puts the lake beyond activateIfDraft's
  // draft/null window, so the recompute cannot emit an auto-activate event. Passing it anyway costs
  // nothing and saves the next reader re-deriving that.
  await recomputeLakeStats(existing, { db, logger });

  return updated;
};
