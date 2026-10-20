import { dataLakeBatchRepository } from '@bike4mind/database';
import type { ILogger } from '@bike4mind/observability';
import { completedBatchStatus, finalizeBatchIfComplete } from '@server/dataLakes/dataLakeBatchProgress';
import { sendToClient } from '@server/websocket/utils';
import type { Types } from 'mongoose';
import { Resource } from 'sst';

type RejectedBatchUpload = {
  _id: Types.ObjectId | string;
  userId: string;
  batchId?: string | null;
};

/** A successful PUT can still be rejected at landing, so the browser cannot account this failure. */
export const recordRejectedUploadBatch = async (
  row: RejectedBatchUpload,
  logger: Pick<ILogger, 'warn' | 'error'>
): Promise<void> => {
  if (!row.batchId) return;

  // Claim and count in one write: a crash between separate writes would lose the failure forever.
  const updated = await dataLakeBatchRepository.rejectPendingUpload(
    row.batchId,
    String(row._id),
    'Upload rejected by the file size or storage limit'
  );
  // Redelivery must also retry finalization and notification after a successful claim.
  const batch = updated ?? (await dataLakeBatchRepository.findById(row.batchId));
  if (!batch) return;

  await finalizeBatchIfComplete(batch, logger);
  await sendToClient(row.userId, Resource.websocket.managementEndpoint, {
    action: 'data_lake_batch_progress',
    batchId: row.batchId,
    failedFiles: batch.failedFiles,
    status: completedBatchStatus(batch),
  });
};
