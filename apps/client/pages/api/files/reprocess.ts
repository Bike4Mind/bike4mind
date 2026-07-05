import { Permission } from '@bike4mind/common';
import { FabFile } from '@bike4mind/database';
import { getFabFileById } from '@server/managers/fabFileManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Request } from 'express';
import { Resource } from 'sst';

/**
 * POST /api/files/reprocess  { fabFileId }
 *
 * Re-runs chunking + vectorization for an existing fabFile. Unlike /api/files/chunk
 * (which requires a chunkSize and doesn't reset state), this resets the processing
 * flags and clears the "no extractable text" note so re-extraction starts clean -
 * useful for files that landed with 0 chunks (failed/partial extraction).
 */
const handler = baseApi().post(
  asyncHandler(async (req: Request<unknown, unknown, { fabFileId?: string }>, res) => {
    const { fabFileId } = req.body;
    if (!fabFileId) throw new BadRequestError('Missing parameter: fabFileId');

    const fabFile = await getFabFileById(fabFileId, req.ability!, Permission.update);
    if (!fabFile) throw new NotFoundError('FabFile not found');
    if (!req.ability?.can?.(Permission.update, fabFile)) throw new BadRequestError('Unauthorized');
    if (fabFile.isChunking) throw new BadRequestError('FabFile is currently being chunked');

    // Reset processing state and clear any prior "no text" flag.
    await FabFile.updateOne(
      { _id: fabFileId },
      {
        $set: {
          isChunking: false,
          chunked: false,
          chunkCount: 0,
          vectorized: false,
          vectorizedChunkCount: 0,
          notes: '',
        },
      }
    );

    await sendToClient(req.user.id, Resource.websocket.managementEndpoint, {
      action: 'update_file_chunk_vector_status',
      fabFileId,
      chunkStatus: 'ongoing',
    });

    const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
    if (!queueUrl) throw new Error('Chunk queue URL not found');

    const messageId = await sendToQueue(queueUrl, { fabFileId: fabFile._id, userId: fabFile.userId });

    return res.json({ messageId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
