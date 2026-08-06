import { IFabFileRepository } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';

interface StampChunkEmbeddingModelAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'update'>;
    fabFileChunks: {
      updateEmbeddingModel: (fabFileId: string, embeddingModel: string) => Promise<void>;
    };
  };
}

/**
 * Bulk-stamps every chunk of a file with the model its vectors were generated under, then
 * records when that stamp completed. Called once a file's WHOLE chunk batch has committed
 * (not per-chunk) - a per-chunk stamp on every vectorize message would leave a file's chunks
 * inconsistently labelled while a multi-message batch is still in flight.
 *
 * `chunkEmbeddingModelStampedAt` is the readiness signal the Atlas `$vectorSearch` cutover reads
 * (see atlasSearchIndex.ts / vectorSearchEligibility.ts) - it must be set AFTER the chunk stamp
 * commits, never before, or a reader could see "ready" while chunks are still unstamped.
 *
 * Both writes run in one transaction: without it, a crash between them would leave the chunks
 * correctly stamped but the readiness stamp permanently unset - the vectorize handler's own
 * idempotency check already treats this file as done, so no later SQS redelivery would retry it.
 */
export const stampChunkEmbeddingModel = async (
  fabFileId: string,
  embeddingModel: string,
  { db }: StampChunkEmbeddingModelAdapters
): Promise<void> => {
  await withTransaction(async () => {
    await db.fabFileChunks.updateEmbeddingModel(fabFileId, embeddingModel);
    await db.fabFiles.update({ id: fabFileId, chunkEmbeddingModelStampedAt: new Date() });
  });
};
