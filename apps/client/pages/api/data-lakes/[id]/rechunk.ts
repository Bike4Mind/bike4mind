import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
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
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    // `failedCount` distinguishes "rebuild finished" from "some files gave up": a failed re-chunk
    // (error set, no chunks) is invisible to detection, so the badge alone would read it as done.
    const [underChunked, failedCount] = await Promise.all([
      dataLakeService.detectUnderChunkedFiles(lake, detectDeps),
      dataLakeService.countFailedLakeFiles(lake, { db: { fabFiles: fabFileRepository } }),
    ]);
    return res.json({ underChunkedCount: underChunked.length, failedCount });
  })
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const { limit } = RechunkInput.parse(req.body ?? {});
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const detected = await dataLakeService.detectUnderChunkedFiles(lake, detectDeps);
    const wave = detected.slice(0, limit ?? dataLakeService.DEFAULT_REBUILD_WAVE);

    let enqueued = 0;
    if (wave.length > 0) {
      const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
      if (!queueUrl) throw new Error('Chunk queue URL not found');
      // Reset the wave, then enqueue it. No producer-side claim: mutual exclusion is the chunk
      // worker's compare-and-set (fabFileChunk.ts), which resolves a duplicate whether it came from
      // a second wave, the rescue sweep, or an SQS redelivery. The reset flips `chunked` off so the
      // re-enqueued job clears the worker's idempotency guard.
      const userById = new Map(wave.map(f => [f.fabFileId, f.userId] as const));
      const ids = [...userById.keys()];
      await fabFileRepository.resetChunkStateByIds(ids);
      // allSettled, not all: one failed send must not fail the whole wave. A file whose send didn't
      // land is left in the reset state (chunked:false, chunkCount:0), which is exactly what the
      // rescue sweep selects on, so it self-heals on the next pass rather than needing an undo.
      const results = await Promise.allSettled(
        ids.map(id => sendToQueue(queueUrl, { fabFileId: id, userId: userById.get(id)! }))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        req.logger?.error?.(
          `rechunk: ${failed}/${ids.length} sends failed for lake ${lake.id}; left reset for the rescue sweep`
        );
      }
      enqueued = ids.length - failed;
    }

    return res.json({
      detected: detected.length,
      enqueued,
      remaining: detected.length - enqueued,
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;
