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
 * GET  /api/data-lakes/:id/rechunk           -> { underChunkedCount, failedCount }
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
 * Auth diverges from per-file /api/files/reprocess (CASL ability) on purpose: this re-chunks files
 * already in the lake, attaching nothing and mutating no lake document, so the POST gates on
 * `assertLakeRebuildAccess` rather than `assertLakeWriteAccess` - the one /api/data-lakes write
 * that does not require a lake document to exist (see that gate's comment for why).
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
    const lake = await dataLakeService.assertLakeRebuildAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const detected = await dataLakeService.detectUnderChunkedFiles(lake, detectDeps);
    const wave = detected.slice(0, limit ?? dataLakeService.DEFAULT_REBUILD_WAVE);

    let enqueued = 0;
    if (wave.length > 0) {
      const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
      if (!queueUrl) throw new Error('Chunk queue URL not found');
      // Reset the wave, then enqueue exactly what the reset changed. The reset is preconditioned on
      // isChunking:{$ne:true} (see resetChunkStateByIds) - a file a worker is mid-run on is skipped
      // rather than having its lease released - so `resetIds` is a subset of the wave and is what we
      // enqueue. Mutual exclusion itself remains the chunk worker's compare-and-set.
      const userById = new Map(wave.map(f => [f.fabFileId, f.userId] as const));
      const resetIds = await fabFileRepository.resetChunkStateByIds([...userById.keys()]);
      // allSettled, not all: one failed send must not fail the whole wave. A file whose send didn't
      // land is left in the reset state (chunked:false, chunkCount:0), which is exactly what the
      // rescue sweep selects on, so it self-heals on the next pass rather than needing an undo.
      //
      // NO `chunkSize` on purpose, unlike /converge which sends `policy.requiredTarget`. This door
      // restores RETRIEVABILITY and is deliberately policy-independent: it has to work on a lake with
      // no declared target, and a member can belong to several lakes that want different sizes. Making
      // it lake-specific would turn it into a second cross-lake write path - and unlike /converge this
      // route has no cross-lake conflict check, so two lakes would rewrite the same file at each
      // other's target on alternate clicks, the oscillation /converge refuses members to prevent.
      //
      // The visible cost, which is intended: on a lake that DOES declare a target, repaired files come
      // back searchable but off-policy, so health dips right after a successful repair until Converge
      // is run once. Documented for owners in knowledge-management.md. Retrieval first, conformance
      // second - a wrong-sized searchable file still answers; an unsearchable one does not.
      const results = await Promise.allSettled(
        resetIds.map(id => sendToQueue(queueUrl, { fabFileId: id, userId: userById.get(id)! }))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      const skipped = userById.size - resetIds.length;
      if (failed > 0 || skipped > 0) {
        req.logger?.error?.(
          `rechunk: lake ${lake.id} - ${failed}/${resetIds.length} sends failed; ` +
            `${skipped} file(s) skipped as already being chunked`
        );
      }
      enqueued = resetIds.length - failed;
    }

    return res.json({
      detected: detected.length,
      enqueued,
      remaining: detected.length - enqueued,
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;
