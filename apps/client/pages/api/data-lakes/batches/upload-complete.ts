import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository } from '@bike4mind/database';
import { finalizeBatchIfComplete } from '@server/queueHandlers/dataLakeBatchProgress';
import { Request } from 'express';
import { z } from 'zod';

const UploadCompleteInput = z.object({
  batchId: z.string(),
  // Count of files whose browser upload PUT failed. These never reach S3, so the
  // server pipeline emits no event for them - the client is the only source of truth
  // for this tally, and it must count toward completion or the batch hangs.
  failedFiles: z.number().int().nonnegative().optional(),
  failedFileNames: z.array(z.string()).optional(),
});

/**
 * Signals the end of a batch's browser-upload phase and accounts for uploads that
 * failed client-side. Called once per batch after the wizard finishes uploading.
 *
 * Browser-failed files never enter the chunk/vectorize pipeline, so without this the
 * completion check (vectorizedFiles + failedFiles + skippedFiles >= totalFiles) can
 * never be satisfied and the batch is stuck 'processing' until the reconciler. The
 * increment is atomic ($inc) so it cannot clobber a concurrent pipeline increment on
 * the same counter, and finalization runs through the shared guarded path.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId, failedFiles, failedFileNames } = UploadCompleteInput.parse(req.body);

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // failedFileNames is client-only (the pipeline never writes it), so a plain set
    // races nothing.
    if (failedFileNames !== undefined) {
      await dataLakeBatchRepository.update({ id: batchId, failedFileNames });
    }
    if (failedFiles && failedFiles > 0) {
      await dataLakeBatchRepository.incrementCounter(batchId, 'failedFiles', failedFiles);
    }

    // Guarded, so a pipeline that already finalized this batch is not resurrected.
    await dataLakeBatchRepository.setStatusIfActive(batchId, 'processing');

    // Re-read so the completion check sees both this call's increment and any pipeline
    // increments that landed concurrently; finalize is itself guarded (runs once).
    const fresh = await dataLakeBatchRepository.findById(batchId);
    await finalizeBatchIfComplete(fresh, req.logger);

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
