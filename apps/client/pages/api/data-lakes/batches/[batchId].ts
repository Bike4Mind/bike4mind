import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';

const UpdateBatchInput = z.object({
  status: z.enum(['preparing', 'uploading', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled']),
  failedFiles: z.number().nonnegative().optional(),
  failedFileNames: z.array(z.string()).optional(),
});

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

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
