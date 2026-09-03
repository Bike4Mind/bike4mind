import type { IDataLakeAccessGrantRepository, IDataLakeRepository, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { canManageLake, type ManageActor } from './manageRule';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';
import { recomputeLakeStats } from './recomputeLakeStats';
import { lakeMembershipScope } from './lakeMembershipScope';

export interface UnarchiveResult {
  restoredCount: number;
  skippedDuplicates: number;
}

interface UnarchiveDataLakeAdapters extends LakeConfigAuditAdapters {
  // The event repo is REQUIRED here, unlike the optional shape LakeConfigAuditAdapters carries
  // for recomputeLakeStats: every caller of this service is an API route (there is exactly one
  // per service), so nothing is spared by making it optional and a route that forgot to wire it
  // would go dark silently - the one failure mode an audit must not have. Required here turns
  // that into a compile error.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<
      IDataLakeRepository,
      'findById' | 'settleLifecycleStatus' | 'setStats' | 'activateIfDraft' | 'claimUnarchiving'
    >;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
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
 * (not restored). Owner or admin only. Uses transitional 'unarchiving' state - the archive axis's
 * own, distinct from the delete axis's 'restoring' (see DATA_LAKE_STATUSES).
 *
 * Both the dedup read and the reversal are bounded by `filesArchivedAt`, this lake's own archive
 * stamp: it stops the dedup pass from reading (and, on a hash match, soft-deleting) a sibling or
 * co-owning lake's own archived member, and stops the reversal from freeing it (see
 * `unarchiveByDataLakeTag`'s own doc for why a meta-tag match is not exempt from the bound).
 */
export const unarchiveDataLake = async (
  actor: ManageActor,
  dataLakeId: string,
  { db, logger }: UnarchiveDataLakeAdapters
): Promise<UnarchiveResult> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }
  // Loaded once and reused for the audit event's manage rung: the gate and the recorded rung must
  // agree on one grant set, not two reads that could disagree.
  const grants = await loadActiveLakeGrants(existing, { db });
  if (!canManageLake(existing, actor, grants)) {
    throw new BadRequestError('You do not have permission to restore this data lake');
  }
  // Allow re-entry from the transitional 'unarchiving' state so a crashed prior attempt can be
  // retried (the dedup + undelete + recompute below are idempotent). The legacy shared 'restoring'
  // is admitted for the same reason, for lakes caught mid-reversal by the deploy that split the two
  // axes apart - claimUnarchiving converts those onto 'unarchiving'.
  if (existing.status !== 'archived' && existing.status !== 'unarchiving' && existing.status !== 'restoring') {
    throw new BadRequestError(`Cannot restore a data lake in '${existing.status}' status`);
  }

  // Conditional on the statuses the guard above admitted, NOT a blind $set: the check ran against a
  // document read moments ago, and deleteDataLake accepts 'archived' too, so a delete landing in
  // that gap must make this LOSE rather than be overwritten. Overwriting it would carry the lake on
  // to the terminal 'active' write below with every member already soft-deleted, and
  // restoreDeletedDataLake refuses an 'active' lake - the files would have no route back.
  // Mirrors claimRestoring on the delete axis.
  const entered = await db.dataLakes.claimUnarchiving(dataLakeId);
  if (!entered) {
    // Re-read only on the rare loss path, so the refusal names the status that actually won rather
    // than the stale one the guard saw.
    const current = await db.dataLakes.findById(dataLakeId);
    throw new BadRequestError(
      current
        ? `Cannot restore a data lake in '${current.status}' status`
        : 'This data lake is no longer available to restore'
    );
  }

  const scope = lakeMembershipScope(existing);
  // undefined for a lake archived before `filesArchivedAt` existed, which keeps both the dedup
  // read and the reversal unbounded - the pre-this-field behavior.
  const stampedAt = existing.filesArchivedAt ?? undefined;

  // Dedup pass: a LIVE (non-archived, non-deleted) file with the same hash means the
  // file was re-uploaded while archived - the live copy wins.
  const archived = await db.fabFiles.findArchivedByDataLakeTag(scope, stampedAt);
  const archivedHashes = archived.map(f => f.contentHash).filter((h): h is string => !!h);

  let skippedDuplicates = 0;
  if (archivedHashes.length > 0) {
    // Meta-tag only, NOT the membership scope: the loser of this comparison is soft-deleted
    // (recoverable) below, and fileTagPrefix is not unique, so a prefix match could nominate a
    // live file belonging to a DIFFERENT lake as the winner and soft-delete this lake's archived
    // member. Any re-upload worth deduping carries the meta-tag, so the narrow probe loses
    // nothing; at worst a prefix-only re-upload leaves a duplicate, which beats discarding the
    // wrong file.
    const live = await db.fabFiles.findByContentHashesInDataLake(archivedHashes, existing.datalakeTag);
    const liveHashes = new Set(live.map(f => f.contentHash));
    const duplicateIds = archived.filter(f => f.contentHash && liveHashes.has(f.contentHash)).map(f => f.id);
    if (duplicateIds.length > 0) {
      // The only HARD delete in the lifecycle family, so it is the one side effect that must not
      // run on a lost claim: everything else here is reversible, but rows removed while another
      // caller is un-deleting them are gone for good. Re-read the status immediately before it and
      // skip if this caller no longer holds 'unarchiving' - the settle below would refuse anyway,
      // and the duplicates it leaves behind are the same benign outcome as a prefix-only re-upload
      // (see the meta-tag note above).
      //
      // Narrows the window rather than closing it: there is no transaction spanning the status
      // document and the file rows, so a claim lost in the microseconds after this read still lets
      // the delete through. Worth doing anyway - the unguarded window was the whole dedup pass.
      const holder = await db.dataLakes.findById(dataLakeId);
      if (holder?.status !== 'unarchiving') {
        logger?.warn?.('[dataLakes] unarchive lost its claim before the dedup pass; leaving duplicates in place', {
          dataLakeId,
          status: holder?.status,
        });
      } else {
        await db.fabFiles.deleteManyInIds(duplicateIds);
        skippedDuplicates = duplicateIds.length;
      }
    }
  }

  // Restore the remaining archived files (the non-duplicates).
  const restoredCount = await db.fabFiles.unarchiveByDataLakeTag(scope, stampedAt);

  // Explicit null, not undefined (mongoose drops undefined): a later re-archive claims a FRESH
  // stamp via claimFilesArchivedAt's set-if-unset, rather than reusing this spent one.
  // Terminal transition only - see the note on archiveDataLake's settle step.
  const updated = await db.dataLakes.settleLifecycleStatus(dataLakeId, 'unarchiving', {
    status: 'active',
    filesArchivedAt: null,
    ...lakeConfigWriteStamp(actor),
  });
  // Null now covers two cases the caller must tell apart, so the loss path re-reads. A lake that
  // MOVED means a delete or purge won mid-operation: reported, because settling 'active' anyway is
  // exactly the write that used to leave a lake reading live with every member soft-deleted. A lake
  // that VANISHED keeps the lenient behavior this path has always had - there is nothing to diff
  // against and nothing to conflict with.
  if (!updated) {
    const current = await db.dataLakes.findById(dataLakeId);
    if (current) {
      throw new BadRequestError(
        `This data lake moved to '${current.status}' while it was being restored; the restore did not complete`
      );
    }
  } else {
    await recordLakeConfigChange(
      {
        actor,
        lake: existing,
        grants,
        action: 'unarchive',
        // Diffed against THIS write's own fields, never against `updated`: `BaseModel.update` is a
        // `findOneAndUpdate` returning the merged document, so a concurrent writer's `$set` landing in
        // the gap would be recorded under this caller's principal and rung. Same reasoning, and the
        // same fix, as `updateDataLake` - see its note. The field set here is fixed and small, so the
        // projection is exact rather than reconstructed.
        changes: diffLakeConfig(existing, { ...existing, status: 'active', filesArchivedAt: null }),
      },
      { db, logger }
    );
  }
  // Logger forwarded for parity with every other recompute call, not because an audit row is
  // expected here: this runs AFTER the status move, which puts the lake beyond activateIfDraft's
  // draft/null window, so the recompute cannot emit an auto-activate event. Passing it anyway costs
  // nothing and saves the next reader re-deriving that.
  await recomputeLakeStats(existing, { db, logger });

  return { restoredCount, skippedDuplicates };
};
