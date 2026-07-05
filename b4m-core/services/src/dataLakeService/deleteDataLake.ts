import type {
  IDataLakeDocument,
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { bestEffortIndexRemove, type RetrievalIndexPort } from './ports';

interface DeleteDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update'>;
    batches: Pick<IDataLakeBatchRepository, 'findActiveByDataLakeId' | 'markTerminalIfActive'>;
    fabFiles: Pick<IFabFileRepository, 'softDeleteByDataLakeTag'>;
  };
  retrievalIndex?: RetrievalIndexPort;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Phase 1 of permanent delete: cancels in-flight batches, soft-deletes the lake's
 * files, best-effort removes them from the retrieval index, and marks the lake
 * 'deleted' (still recoverable - shown in a deleted view). The destructive purge is
 * a separate, explicit phase 2 (cleanupDeletedDataLake). Owner or admin only.
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

  await db.dataLakes.update({ id: dataLakeId, status: 'deleting' });

  await db.fabFiles.softDeleteByDataLakeTag(existing.datalakeTag);
  await bestEffortIndexRemove(retrievalIndex, existing.datalakeTag, logger);

  const updated = await db.dataLakes.update({ id: dataLakeId, status: 'deleted' });
  if (!updated) {
    throw new NotFoundError('Data lake not found after delete');
  }
  return updated;
};
