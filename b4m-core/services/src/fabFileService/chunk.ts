import { IFabFileChunkDocument, IFabFileRepository, IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { NotFoundError, secureParameters, SmartChunker } from '@bike4mind/utils';
import { z } from 'zod';

const chunkFileSchema = z.object({
  fabFileId: z.string(),
  embeddingModel: z.string(),
  // Soft chunk-size cap in tokens (see DEFAULT_PASSAGE_TOKEN_TARGET). Optional: the
  // chunker's passage-granularity default applies when omitted.
  passageTokenTarget: z.number().int().positive().optional(),
});

type ChunkFileParameters = z.infer<typeof chunkFileSchema>;

interface ChunkFileAdapters {
  db: {
    fabFiles: IFabFileRepository;
    fabFileChunks: {
      deleteManyByFabFileId: (fabFileId: string) => Promise<void>;
      bulkInsert: (chunks: Omit<IFabFileChunkDocument, 'id'>[]) => Promise<IFabFileChunkDocument[]>;
      update: (chunk: IFabFileChunkDocument) => Promise<unknown>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
  };
  storage: {
    getContentAsBuffer: (filePath: string) => Promise<Buffer>;
  };
  logger: Logger;
  /**
   * Self-host OpenSearch only (undefined elsewhere). Re-chunking deletes the old
   * FabFileChunk rows and their embeddingModel with them - without this, the old chunks'
   * OpenSearch vectors would survive as permanent orphans in the OLD model's index.
   */
  searchIndex?: { deleteByFabFileId: (fabFileId: string, embeddingModel: string) => Promise<void> };
}

export const chunkFabfile = async (
  user: IUserDocument,
  parameters: ChunkFileParameters,
  { db, storage, logger, searchIndex }: ChunkFileAdapters
) => {
  const { fabFileId, embeddingModel, passageTokenTarget } = secureParameters(parameters, chunkFileSchema);

  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, fabFileId);
  if (!fabFile) throw new NotFoundError('FabFile not found');

  logger.updateMetadata({ mimeType: fabFile.mimeType });

  const chunker = new SmartChunker(embeddingModel, storage, logger, { passageTokenTarget });
  const chunks = await chunker.chunkFile(fabFile);
  chunker.freeEncoder();
  Logger.globalInstance.log(`Completed chunking file into ${chunks.length} chunks`);

  // Captured before it's overwritten below - the OLD chunks about to be deleted were indexed
  // (if at all) under THIS model's OpenSearch index, not the new one.
  const previousEmbeddingModel = fabFile.embeddingModel;

  fabFile.isChunking = false;
  fabFile.chunked = chunks.length > 0;
  fabFile.chunkCount = chunks.length;

  fabFile.isVectorizing = false;
  fabFile.vectorized = chunks.length > 0;
  fabFile.vectorizedChunkCount = 0;

  fabFile.embeddingModel = embeddingModel;
  // The old chunks (and their embeddingModel stamps) are about to be deleted below - a stale
  // readiness timestamp would make the Atlas cutover read path treat this file as ANN-ready
  // before the new chunks are re-stamped, silently returning zero results (see
  // vectorSearchEligibility.ts).
  fabFile.chunkEmbeddingModelStampedAt = null;

  await db.fabFiles.update(fabFile);

  await db.fabFileChunks.deleteManyByFabFileId(fabFileId);
  if (searchIndex && previousEmbeddingModel) {
    await searchIndex.deleteByFabFileId(fabFileId, previousEmbeddingModel);
  }

  const fabFileChunks = await Promise.all(
    chunks.map(async chunk => {
      return {
        ...chunk,
        fabFileId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    })
  );

  const result = await db.fabFileChunks.bulkInsert(fabFileChunks);

  return result;
};
