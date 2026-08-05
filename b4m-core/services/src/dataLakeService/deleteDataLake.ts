import type {
  IDataLakeDocument,
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { lakeMembershipScope } from './lakeMembershipScope';
import { warnOnPrefixCollision } from './tagPrefixCollision';
import { bestEffortIndexRemove, type RetrievalIndexPort } from './ports';

interface DeleteDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update' | 'find'>;
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
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  { db, retrievalIndex, logger }: DeleteDataLakeAdapters
): Promise<IDataLakeDocument> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    throw new NotFoundError('Data lake not found');
  }
  if (!actor.isAdmin && existing.createdByUserId !== actor.userId) {
    throw new BadRequestError('Only the creator can delete this data lake');
  }
  // Only short-circuit on the terminal state. A lake stuck in transitional 'deleting'
  // from a crashed prior attempt must be able to re-run; the phase-1 side effects
  // (cancel batches, soft-delete files, best-effort index removal) are idempotent.
  if (existing.status === 'deleted') {
    return existing;
  }

  // Quiesce in-flight batches before teardown.
  const activeBatches = await db.batches.findActiveByDataLakeId(dataLakeId);
  await Promise.all(activeBatches.map(b => db.batches.markTerminalIfActive(b.id, 'cancelled')));

  // The stamp this teardown keys its batch to, recorded on the lake so restore can un-delete these
  // rows and only these rows. A mark that is already live is REUSED, so a re-run after a crash
  // stamps into the same batch instead of orphaning the first attempt's rows outside the window.
  //
  // undefined for one case: a lake already sitting in 'deleting' with no mark, which means a
  // teardown that started before this field existed. Its rows carry a stamp nothing
  // recorded, so leaving the mark unset keeps restore unbounded (the old behavior) instead of
  // bounding it to a stamp those rows do not have, which would strand them deleted.
  const stamp = existing.filesDeletedAt ?? (existing.status === 'deleting' ? undefined : new Date());

  // Same write that flags the transitional state, so the mark can never be newer than the rows it
  // names: a crash between the two leaves an empty batch a re-run completes, where the reverse order
  // would leave stamped rows no mark points at.
  await db.dataLakes.update({ id: dataLakeId, status: 'deleting', ...(stamp ? { filesDeletedAt: stamp } : {}) });

  await warnOnPrefixCollision(db, existing, logger);
  const scope = lakeMembershipScope(existing);
  await db.fabFiles.softDeleteByDataLakeTag(scope, stamp);
  // Not softDeleteByDataLakeTag's return: it reports only the files this call flipped, so a re-run
  // after a crashed attempt would hand the index an empty set. findIdsByDataLakeTag sees
  // soft-deleted members too and stays stable across re-runs.
  await bestEffortIndexRemove(retrievalIndex, scope, () => db.fabFiles.findIdsByDataLakeTag(scope), logger);

  const updated = await db.dataLakes.update({ id: dataLakeId, status: 'deleted' });
  if (!updated) {
    throw new NotFoundError('Data lake not found after delete');
  }
  return updated;
};
