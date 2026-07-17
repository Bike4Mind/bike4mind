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
  /** Bounds peak concurrency of the per-file/per-batch deletes (background consumer sets this). */
  chunkSize?: number;
}

/** Default fan-out chunk size - bounds peak Mongo concurrency for a large lake's sweep. */
const DEFAULT_CLEANUP_CHUNK_SIZE = 100;

/** Run `fn` over `items` in sequential slices of `size`, so peak concurrency stays bounded. */
async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * Phase 2 of permanent delete: the retry-safe hard-delete sweep over chunks, files,
 * batches, and the lake record. Runs in the background cleanup queue consumer (enqueued by an
 * explicit user/admin action), which is why it's idempotent - a partially-failed run leaves the
 * lake in 'deleted' and a DLQ retry re-runs it without error or double-deletion (delete-by-id and
 * deleteMany are no-ops on already-purged data). Fan-outs are chunked (chunkSize) so a large lake
 * stays inside the Lambda timeout. Owner or admin only.
 */
export const cleanupDeletedDataLake = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  { db, retrievalIndex, logger, chunkSize = DEFAULT_CLEANUP_CHUNK_SIZE }: CleanupDeletedDataLakeAdapters
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
  // Chunked so a large lake doesn't fan out unbounded (Lambda timeout/memory); each delete is a
  // no-op on already-purged data, so a DLQ retry resumes safely.
  const fileIds = await db.fabFiles.findIdsByDataLakeTag(existing.datalakeTag);
  await inChunks(fileIds, chunkSize, id => db.fabFileChunks.deleteManyByFabFileId(id));

  // 2. Best-effort retrieval index removal.
  await bestEffortIndexRemove(retrievalIndex, existing.datalakeTag, logger);

  // 3. Hard-delete the files.
  await db.fabFiles.hardDeleteByDataLakeTag(existing.datalakeTag);

  // 4. Delete the lake's batches (chunked, same rationale as the chunk sweep above).
  const batches = await db.batches.find({ dataLakeId });
  await inChunks(batches, chunkSize, b => db.batches.delete(b.id));

  // 5. Delete the lake record last, so a mid-sweep failure leaves it recoverable/re-runnable.
  await db.dataLakes.delete(dataLakeId);
};
