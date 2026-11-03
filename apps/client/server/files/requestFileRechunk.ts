import { Permission } from '@bike4mind/common';
import { getFabFileById } from '@server/managers/fabFileManager';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import type { Request } from 'express';
import { Resource } from 'sst';

export type RechunkOutcome =
  | { status: 'queued'; messageId: string | undefined }
  | { status: 'not_found' }
  | { status: 'denied' }
  | { status: 'already_chunking' };

/**
 * Queues the chunking pipeline for a file the caller can edit. `chunkSize` must already be
 * range-checked: this only loads, authorizes and enqueues. Mapping the outcome to a status is the
 * caller's job.
 *
 * Shared by the SPA-internal POST /api/files/chunk and the public POST /api/v1/files/{id}/chunk,
 * so the two doors cannot authorize differently.
 */
export async function requestFileRechunk(
  req: Request,
  { fabFileId, chunkSize }: { fabFileId: string; chunkSize: string | number }
): Promise<RechunkOutcome> {
  const fabFile = await getFabFileById(fabFileId, req.ability!, Permission.update);
  if (!fabFile) return { status: 'not_found' };

  if (!req.ability?.can?.(Permission.update, fabFile)) return { status: 'denied' };

  if (fabFile.isChunking) return { status: 'already_chunking' };

  await sendToClient(req.user.id, Resource.websocket.managementEndpoint, {
    action: 'update_file_chunk_vector_status',
    fabFileId,
    chunkStatus: 'ongoing',
  });

  const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
  if (!queueUrl) throw new Error('Chunk queue URL not found');

  const messageId = await sendToQueue(queueUrl, {
    fabFileId: fabFile._id,
    userId: fabFile.userId,
    chunkSize,
  });

  return { status: 'queued', messageId };
}
