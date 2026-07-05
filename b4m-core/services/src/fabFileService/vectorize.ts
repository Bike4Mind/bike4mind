import { IFabFileChunkDocument, IFabFileRepository, IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const vectorizeFabFileChunkSchema = z.object({
  fabFileId: z.string(),
  chunkId: z.string(),
});

type VectorizeFabFileChunkParameters = z.infer<typeof vectorizeFabFileChunkSchema>;

interface VectorizeFabFileChunkAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'shareable' | 'update'>;
    fabFileChunks: {
      findById: (id: string) => Promise<IFabFileChunkDocument | null>;
      update: (chunk: IFabFileChunkDocument) => Promise<unknown>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
  };
  llm: {
    createVector: (text: string) => Promise<number[]>;
  };
  logger: Logger;
}

export const vectorizeFabFileChunk = async (
  user: IUserDocument,
  parameters: VectorizeFabFileChunkParameters,
  { db, llm, logger }: VectorizeFabFileChunkAdapters
) => {
  const { fabFileId, chunkId } = secureParameters(parameters, vectorizeFabFileChunkSchema);

  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, fabFileId);
  if (!fabFile) throw new NotFoundError(`FabFile ${fabFileId} not found`);

  logger.updateMetadata({ mimeType: fabFile.mimeType });

  fabFile.vectorized = true;
  fabFile.vectorizedChunkCount ||= 0;
  fabFile.vectorizedChunkCount += 1;

  if (fabFile.vectorizedChunkCount === fabFile.chunkCount) {
    fabFile.isVectorizing = false;
  }

  const fabFileChunk = await db.fabFileChunks.findById(chunkId);

  if (!fabFileChunk) throw new NotFoundError(`FabFileChunk ${chunkId} for FabFile ${fabFileId} not found`);

  await db.fabFiles.update(fabFile);

  const vector = await llm.createVector(fabFileChunk.text);

  fabFileChunk.vector = vector;

  await db.fabFileChunks.update(fabFileChunk);

  return fabFile;
};
