import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, fabFileRepository } from '@bike4mind/database';
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
  // FabFile ids the failed uploads left behind (created at presign, 0 chunks, no S3
  // object). Removed here so they don't inflate the lake's file count.
  failedFileIds: z.array(z.string()).optional(),
});

/**
 * Signals the end of a batch's browser-upload phase, cleaning up and accounting for
 * uploads that failed client-side. Called once per batch after the wizard finishes
 * uploading, whenever the lake is kept (partial success, or an append that fully failed).
 *
 * Two problems it fixes together, server-side, in the right order:
 * - Browser-failed files never enter the chunk/vectorize pipeline, so without an explicit
 *   tally the completion check (vectorizedFiles + failedFiles + skippedFiles >= totalFiles)
 *   is never satisfied and the batch hangs 'processing'. The increment is atomic ($inc) so
 *   it can't clobber a concurrent pipeline increment on the same counter.
 * - Their FabFile records are 0-chunk orphans that computeDataLakeStats would still count.
 *   Deleting them BEFORE finalize (which recomputes lake stats) keeps the file count honest;
 *   doing it here rather than in a separate client call removes an ordering/lost-write race.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId, failedFiles, failedFileNames, failedFileIds } = UploadCompleteInput.parse(req.body);

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // Remove the orphan FabFiles the failed uploads created. A plain owner-scoped
    // soft-delete is complete for these: 0 chunks (nothing to tear down), no S3 object
    // (the PUT never landed), and unreferenced (just created). The ownership check keeps
    // this from ever touching another user's file.
    for (const fileId of failedFileIds ?? []) {
      const owned = await fabFileRepository.findByIdAndUserId(fileId, userId);
      if (owned) {
        await fabFileRepository.update({ id: fileId, deletedAt: new Date() });
      }
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
    // increments that landed concurrently; finalize is itself guarded (runs once) and
    // recomputes lake stats from source - now that the orphans above are gone.
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
