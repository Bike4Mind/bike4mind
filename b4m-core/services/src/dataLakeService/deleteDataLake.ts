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
import { lakeMembershipScope } from './lakeMembershipScope';
import { warnOnPrefixCollision } from './tagPrefixCollision';
import { bestEffortIndexRemove, type RetrievalIndexPort } from './ports';

interface DeleteDataLakeAdapters extends LakeConfigAuditAdapters {
  // The event repo is REQUIRED here, unlike the optional shape LakeConfigAuditAdapters carries
  // for recomputeLakeStats: every caller of this service is an API route (there is exactly one
  // per service), so nothing is spared by making it optional and a route that forgot to wire it
  // would go dark silently - the one failure mode an audit must not have. Required here turns
  // that into a compile error.
  db: LakeConfigAuditAdapters['db'] & {
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update' | 'find' | 'claimFilesDeletedAt'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    batches: Pick<IDataLakeBatchRepository, 'findActiveByDataLakeId' | 'markTerminalIfActive'>;
    fabFiles: Pick<IFabFileRepository, 'softDeleteByDataLakeTag' | 'findIdsByDataLakeTag'>;
  };
  retrievalIndex?: RetrievalIndexPort;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Phase 1 of permanent delete: cancels in-flight batches, soft-deletes the lake's
 * files under one recorded stamp (`filesDeletedAt`, so restore can reverse this batch
 * and nothing else), best-effort removes them from the retrieval index, and marks the
 * lake 'deleted' (still recoverable - shown in a deleted view). The destructive purge
 * is a separate, explicit phase 2 (cleanupDeletedDataLake). Owner or admin only.
 */
export const deleteDataLake = async (
  actor: ManageActor,
  dataLakeId: string,
  { db, retrievalIndex, logger }: DeleteDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }
  // Loaded once and reused for the audit event's manage rung: the gate and the recorded rung must
  // agree on one grant set, not two reads that could disagree.
  const grants = await loadActiveLakeGrants(existing, { db });
  if (!canManageLake(existing, actor, grants)) {
    throw new BadRequestError('You do not have permission to delete this data lake');
  }
  // Only short-circuit on the terminal state. A lake stuck in transitional 'deleting'
  // from a crashed prior attempt must be able to re-run; the phase-1 side effects
  // (cancel batches, soft-delete files, best-effort index removal) are idempotent.
  //
  // 'purging' short-circuits too, and NOT because it is terminal - because it is past the point
  // of no return (#1744). Falling through would re-run phase 1 on a lake whose hard delete is
  // already accepted, whose closing `status: 'deleted'` write would silently un-purge it: the
  // sweep's guard would then throw and the consumer would swallow the purge with a WARN.
  if (existing.status === 'deleted' || existing.status === 'purging') {
    return existing;
  }

  // Quiesce in-flight batches before teardown.
  const activeBatches = await db.batches.findActiveByDataLakeId(dataLakeId);
  await Promise.all(activeBatches.map(b => db.batches.markTerminalIfActive(b.id, 'cancelled')));

  // The stamp this teardown keys its batch to, recorded on the lake so restore can un-delete these
  // rows and only these rows. Claimed set-if-unset and swept with whatever comes BACK, so a re-run
  // after a crash and a concurrent second teardown both fold into the first attempt's batch rather
  // than recording a mark no row carries.
  //
  // Skipped for one case: a lake already sitting in 'deleting' with no mark, which means a teardown
  // that started before this field existed. Its rows carry a stamp nothing recorded, so leaving the
  // mark unset keeps restore unbounded (the old behavior) instead of bounding it to a stamp those
  // rows do not have, which would strand them deleted.
  let stamp: Date | undefined;
  const preMarkSweepInFlight = existing.status === 'deleting' && !existing.filesDeletedAt;
  if (!preMarkSweepInFlight) {
    stamp = (await db.dataLakes.claimFilesDeletedAt(dataLakeId, new Date())) ?? undefined;
    // No stamp came back: the claim lost AND the fallback read found none either, so a restore
    // cleared it between the two round trips. The sweep still runs, just unmarked, and this one
    // lake's restore goes back to reversing unbounded. It fails open, but not silently - without
    // this line the only symptom is a restore that over-restores months later.
    if (!stamp) {
      logger?.warn('[dataLakes] teardown recorded no stamp; this lake will restore unbounded', { dataLakeId });
    }
  }

  await db.dataLakes.update({ id: dataLakeId, status: 'deleting' });

  await warnOnPrefixCollision(db, existing, logger);
  const scope = lakeMembershipScope(existing);
  await db.fabFiles.softDeleteByDataLakeTag(scope, stamp);
  // Not softDeleteByDataLakeTag's return: it reports only the files this call flipped, so a re-run
  // after a crashed attempt would hand the index an empty set. findIdsByDataLakeTag sees
  // soft-deleted members too and stays stable across re-runs.
  await bestEffortIndexRemove(retrievalIndex, scope, () => db.fabFiles.findIdsByDataLakeTag(scope), logger);

  // Terminal transition only - see the note on archiveDataLake's settle step.
  const updated = await db.dataLakes.update({ id: dataLakeId, status: 'deleted', ...lakeConfigWriteStamp(actor) });
  if (!updated) {
    throw new NotFoundError('Data lake not found after delete');
  }
  await recordLakeConfigChange(
    {
      actor,
      lake: existing,
      grants,
      action: 'delete',
      // Diffed against THIS write's own fields, never against `updated`: `BaseModel.update` is a
      // `findOneAndUpdate` returning the merged document, so a concurrent writer's `$set` landing in
      // the gap would be recorded under this caller's principal and rung. Same reasoning, and the
      // same fix, as `updateDataLake` - see its note. The field set here is fixed and small, so the
      // projection is exact rather than reconstructed.
      changes: diffLakeConfig(existing, { ...existing, status: 'deleted' }),
    },
    { db, logger }
  );
  return updated;
};
