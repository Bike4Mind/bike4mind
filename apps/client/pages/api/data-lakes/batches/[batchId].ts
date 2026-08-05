import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { BATCH_TERMINAL_STATUSES, type BatchStatus } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';

const UpdateBatchInput = z.object({
  status: z.enum(['preparing', 'uploading', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled']),
  failedFiles: z.number().nonnegative().optional(),
  failedFileNames: z.array(z.string()).optional(),
});

/**
 * Rebuild the lake's stats once a batch stops here rather than at the finalizer. A batch the
 * client fails or cancels after some files already landed never reaches
 * `finalizeBatchIfComplete`, and the stuck-batch reconciler skips terminal batches. Nothing on
 * the batch's own path is left to count what did arrive, so until some unrelated door touches
 * the lake its counts are wrong and, if it is still a draft, it stays invisible.
 *
 * Best-effort: the batch transition has already committed, so a failure here is stale stats, not
 * a failed request.
 */
const recomputeLakeAfterTerminal = async (
  status: BatchStatus,
  dataLakeId: string,
  logger: { error: (msg: string) => void }
): Promise<void> => {
  if (!BATCH_TERMINAL_STATUSES.includes(status)) return;

  try {
    const lake = await dataLakeRepository.findById(dataLakeId);
    if (!lake) return;
    await dataLakeService.recomputeLakeStats(lake, {
      db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
    });
  } catch (error) {
    logger.error(`Error recomputing data lake stats for terminal batch in lake ${dataLakeId}: ${error}`);
  }
};

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET: batch status
  .get(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId } = req.query as { batchId: string };

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    return res.json(batch);
  })
  // PUT: update batch status
  .put(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId } = req.query as { batchId: string };

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const data = UpdateBatchInput.parse(req.body);

    await dataLakeBatchRepository.update({
      id: batchId,
      status: data.status,
      ...(data.failedFiles !== undefined && { failedFiles: data.failedFiles }),
      ...(data.failedFileNames !== undefined && { failedFileNames: data.failedFileNames }),
      ...((data.status === 'completed' || data.status === 'completed_with_errors') && { completedAt: new Date() }),
    });

    await recomputeLakeAfterTerminal(data.status, batch.dataLakeId, req.logger);

    return res.json({ success: true });
  })
  // DELETE: cancel batch
  .delete(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId } = req.query as { batchId: string };

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // Guarded cancel: only transitions a still-non-terminal batch, so it can't race
    // a concurrent finalization.
    const cancelled = await dataLakeBatchRepository.markTerminalIfActive(batchId, 'cancelled');
    if (!cancelled) {
      return res.status(400).json({ error: `Batch is already ${batch.status}` });
    }

    await recomputeLakeAfterTerminal('cancelled', batch.dataLakeId, req.logger);

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
