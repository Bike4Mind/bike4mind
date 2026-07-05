import type {
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
  IFabFileChunkRepository,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { bestEffortIndexRemove, type RetrievalIndexPort } from './ports';

interface CleanupDeletedDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'delete'>;
    batches: Pick<IDataLakeBatchRepository, 'find' | 'delete'>;
    fabFiles: Pick<IFabFileRepository, 'findIdsByDataLakeTag' | 'hardDeleteByDataLakeTag'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'deleteManyByFabFileId'>;
  };
  retrievalIndex?: RetrievalIndexPort;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Phase 2 of permanent delete: the retry-safe hard-delete sweep over chunks, files,
 * batches, and the lake record. Triggered by an explicit user/admin action (not a
 * cron). Idempotent - a partially-failed run leaves the lake in 'deleted' and can be
 * re-run without error or double-deletion (delete-by-id and deleteMany are no-ops on
 * already-purged data). Owner or admin only.
 */
export const cleanupDeletedDataLake = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  { db, retrievalIndex, logger }: CleanupDeletedDataLakeAdapters
): Promise<void> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    // Already gone - idempotent success.
    return;
  }
  if (!actor.isAdmin && existing.createdByUserId !== actor.userId) {
    throw new BadRequestError('Only the creator can clean up this data lake');
  }
  if (existing.status !== 'deleted') {
    throw new BadRequestError('Data lake must be soft-deleted before cleanup');
  }

  // 1. Delete chunks for every file carrying the lake tag (covers soft-deleted files too).
  const fileIds = await db.fabFiles.findIdsByDataLakeTag(existing.datalakeTag);
  await Promise.all(fileIds.map(id => db.fabFileChunks.deleteManyByFabFileId(id)));

  // 2. Best-effort retrieval index removal.
  await bestEffortIndexRemove(retrievalIndex, existing.datalakeTag, logger);

  // 3. Hard-delete the files.
  await db.fabFiles.hardDeleteByDataLakeTag(existing.datalakeTag);

  // 4. Delete the lake's batches.
  const batches = await db.batches.find({ dataLakeId });
  await Promise.all(batches.map(b => db.batches.delete(b.id)));

  // 5. Delete the lake record last, so a mid-sweep failure leaves it recoverable/re-runnable.
  await db.dataLakes.delete(dataLakeId);
};
