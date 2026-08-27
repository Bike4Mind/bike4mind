import { IFabFileChunkRepository, IFabFileRepository, IUserDocument } from '@bike4mind/common';
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
    fabFileChunks: Pick<IFabFileChunkRepository, 'findById' | 'update'>;
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

  const vectorizedChunkCount = (fabFile.vectorizedChunkCount ?? 0) + 1;
  const justCompleted = vectorizedChunkCount === fabFile.chunkCount;

  // In-memory mutations kept for the return value's sake (see below) - the actual write payload
  // is built explicitly from locals just below, naming only the fields this function owns. A
  // whole-object `update(fabFile)` (as this used to do) $sets every key including isChunking/
  // chunkClaimedAt, the exact clobber #1802 fixed in chunk.ts - see that file's comment for why.
  fabFile.vectorized = true;
  fabFile.vectorizedChunkCount = vectorizedChunkCount;
  if (justCompleted) fabFile.isVectorizing = false;

  const fabFileChunk = await db.fabFileChunks.findById(chunkId);
  if (!fabFileChunk) throw new NotFoundError(`FabFileChunk ${chunkId} for FabFile ${fabFileId} not found`);

  await db.fabFiles.update({
    id: fabFile.id,
    vectorized: true,
    vectorizedChunkCount,
    ...(justCompleted ? { isVectorizing: false } : {}),
  });

  const vector = await llm.createVector(fabFileChunk.text);

  await db.fabFileChunks.update({ id: fabFileChunk.id, vector });

  return fabFile;
};
