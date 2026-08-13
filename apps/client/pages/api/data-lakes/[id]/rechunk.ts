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
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });

    const detected = await dataLakeService.detectUnderChunkedFiles(lake, detectDeps);
    const wave = detected.slice(0, limit ?? dataLakeService.DEFAULT_REBUILD_WAVE);

    let enqueued = 0;
    if (wave.length > 0) {
      const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
      if (!queueUrl) throw new Error('Chunk queue URL not found');
      // Atomically CLAIM the wave and enqueue ONLY the files this call actually won: a file a
      // concurrent wave already claimed isn't returned, so the two waves can't both enqueue it and
      // double-process it. The claim flips `chunked` off (so the re-enqueued job clears
      // fabFileChunk.ts's idempotency guard) and hides the file from the rescue sweep.
      const claimedById = new Map(wave.map(f => [f.fabFileId, f.userId] as const));
      const claimed = await fabFileRepository.claimFilesForRechunkByIds([...claimedById.keys()]);
      // allSettled, not all: one failed send must not fail the batch and strand the OTHER claimed
      // files with nothing on the queue. Release the claim on any file whose send didn't land so it
      // self-heals (re-detected / re-swept) instead of sitting claimed-and-invisible. `claimedAt` is
      // the claim token: the worker only re-chunks a file that still carries this exact stamp, so a
      // duplicate delivery or a stale rescue re-enqueue can't double-process it.
      const results = await Promise.allSettled(
        claimed.map(({ id, claimedAt }) => sendToQueue(queueUrl, { fabFileId: id, userId: claimedById.get(id)!, claimedAt }))
      );
      const failedIds = claimed.filter((_, i) => results[i].status === 'rejected').map(c => c.id);
      if (failedIds.length > 0) {
        req.logger?.error?.(
          `rechunk: ${failedIds.length}/${claimed.length} sends failed for lake ${lake.id}, released`
        );
        await fabFileRepository.releaseChunkClaimByIds(failedIds);
      }
      enqueued = claimed.length - failedIds.length;
    }

    return res.json({
      detected: detected.length,
      enqueued,
      remaining: detected.length - enqueued,
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;
