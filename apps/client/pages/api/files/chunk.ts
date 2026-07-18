import { Permission } from '@bike4mind/common';
import { getFabFileById } from '@server/managers/fabFileManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import { Request } from 'express';
import { Resource } from 'sst';

const handler = baseApi().post(
  asyncHandler(async (req: Request<{ fabFileId: string; chunkSize?: string }>, res) => {
    const { fabFileId, chunkSize } = req.body;
    if (!fabFileId || !chunkSize) throw new BadRequestError('Missing parameters: fabFileId or chunkSize');

    const fabFile = await getFabFileById(fabFileId, req.ability!, Permission.update);
    if (!fabFile) throw new NotFoundError('FabFile not found');

    if (!req.ability?.can?.(Permission.update, fabFile)) throw new BadRequestError('Unauthorized');

    if (fabFile.isChunking) throw new BadRequestError('FabFile is currently being chunked');

    await sendToClient(req.user.id, Resource.websocket.managementEndpoint, {
      action: 'update_file_chunk_vector_status',
      fabFileId,
      chunkStatus: 'ongoing',
    });

    // Resource.fabFileChunkQueue.url resolves under both hosted (identical to the
    // sourceQueueUrls Linkable, built from this .url) and the self-host shim.
    const queueUrl = Resource.fabFileChunkQueue.url;
    if (!queueUrl) throw new Error('Chunk queue URL not found');

    const messageId = await sendToQueue(queueUrl, {
      fabFileId: fabFile._id,
      userId: fabFile.userId,
      chunkSize,
    });

    return res.json({ messageId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
