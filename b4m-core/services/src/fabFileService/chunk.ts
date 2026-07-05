import { IFabFileChunkDocument, IFabFileRepository, IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { NotFoundError, secureParameters, SmartChunker } from '@bike4mind/utils';
import { z } from 'zod';

const chunkFileSchema = z.object({
  fabFileId: z.string(),
  embeddingModel: z.string(),
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
}

export const chunkFabfile = async (
  user: IUserDocument,
  parameters: ChunkFileParameters,
  { db, storage, logger }: ChunkFileAdapters
) => {
  const { fabFileId, embeddingModel } = secureParameters(parameters, chunkFileSchema);

  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, fabFileId);
  if (!fabFile) throw new NotFoundError('FabFile not found');

  logger.updateMetadata({ mimeType: fabFile.mimeType });

  const chunker = new SmartChunker(embeddingModel, storage, logger);
  const chunks = await chunker.chunkFile(fabFile);
  chunker.freeEncoder();
  Logger.globalInstance.log(`Completed chunking file into ${chunks.length} chunks`);

  fabFile.isChunking = false;
  fabFile.chunked = chunks.length > 0;
  fabFile.chunkCount = chunks.length;

  fabFile.isVectorizing = false;
  fabFile.vectorized = chunks.length > 0;
  fabFile.vectorizedChunkCount = 0;

  fabFile.embeddingModel = embeddingModel;

  await db.fabFiles.update(fabFile);

  await db.fabFileChunks.deleteManyByFabFileId(fabFileId);

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
