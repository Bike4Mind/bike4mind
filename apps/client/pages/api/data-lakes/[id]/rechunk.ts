import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, fabFileRepository, fabFileChunkRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';

/**
 * GET  /api/data-lakes/:id/rechunk           -> { underChunkedCount }
 * POST /api/data-lakes/:id/rechunk  { limit } -> { detected, enqueued, remaining }
 *
 * "Rebuild passages": re-chunks the lake's files whose passages predate the passage-target fix
 * (a whole-document blob rather than ~512-token passages), which retrieval can't rank within.
 *
 * Deliberately does NOT reuse the DataLakeBatch progress machinery: that keys off `fabFile.batchId`,
 * and repointing a file's batchId to a maintenance batch would break `applyTaxonomySuggestions` for
 * its original upload batch (it re-reads the batch's files by batchId). Progress is instead the GET
 * count decreasing as waves complete - a reset file drops out of the "chunked" set until it
 * re-chunks into passages under the threshold.
 *
 * Throttle: POST re-chunks at most `limit` files per call (default DEFAULT_REBUILD_WAVE, hard-capped
 * at MAX_REBUILD_WAVE), worst-first. The embedding cost of a re-chunk is trivial in dollars; the risk
 * is bursting the embedding provider's tokens-per-minute, so the caller repeats bounded waves (the
 * UI reads `remaining`) rather than fanning out the whole lake at once.
 *
 * Auth diverges from per-file /api/files/reprocess (CASL ability) on purpose: this is a lake-level
 * management action, so it gates on lake ownership/admin like every other /api/data-lakes write.
 */

const RechunkInput = z.object({
  limit: z.number().int().positive().max(dataLakeService.MAX_REBUILD_WAVE).optional(),
});

const detectDeps = { db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository } };

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });
    const underChunked = await dataLakeService.detectUnderChunkedFiles(lake, detectDeps);
    return res.json({ underChunkedCount: underChunked.length });
  })
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const { limit } = RechunkInput.parse(req.body ?? {});
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });

    const detected = await dataLakeService.detectUnderChunkedFiles(lake, detectDeps);
    const wave = detected.slice(0, limit ?? dataLakeService.DEFAULT_REBUILD_WAVE);

    if (wave.length > 0) {
      // Clear the idempotency flags so the re-enqueued chunk job actually re-chunks. A reset file
      // reads as un-chunked until its job completes, so it also drops out of the next detection -
      // repeated waves advance through the population without re-enqueuing an in-flight file.
      await fabFileRepository.resetChunkStateByIds(wave.map(f => f.fabFileId));
      const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
      if (!queueUrl) throw new Error('Chunk queue URL not found');
      // Enqueue under each file's OWNER userId (as /api/files/reprocess does), so the chunk handler
      // resolves the same identity the original ingest used.
      await Promise.all(wave.map(f => sendToQueue(queueUrl, { fabFileId: f.fabFileId, userId: f.userId })));
    }

    return res.json({
      detected: detected.length,
      enqueued: wave.length,
      remaining: detected.length - wave.length,
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;
