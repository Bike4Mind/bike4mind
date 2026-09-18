import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  fabFileChunkRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { CONVERGENCE_ORIGIN } from '@server/queueHandlers/convergenceProvenance';
import { isConvergenceHalted } from '@server/queueHandlers/convergenceKillSwitch';
import { resolveEffectiveEmbeddingModel } from '@server/embeddings/effectiveEmbeddingModel';

/**
 * GET  /api/data-lakes/:id/rechunk  -> { underChunkedCount, failedCount, staleEmbeddingSpaceCount }
 * POST /api/data-lakes/:id/rechunk  { limit, select } -> { detected, enqueued, remaining }
 *
 * "Rebuild passages": re-chunks the lake's files whose passages predate the passage-target fix
 * (a whole-document blob rather than ~512-token passages), which retrieval can't rank within.
 *
 * `select` chooses WHICH population the wave drains; the reset-and-enqueue below is identical for
 * both, which is why this is one door and not two. `stale-embedding-space` is the whole-lake
 * re-embed: after the deployment's default embedding model moves, every file still labelled with
 * the previous space is withheld by the majority vote, silently and with no error - and no other
 * route selects on a label at all (Converge grades chunk SIZE). Without it the only way to migrate
 * a lake is a one-off script against the database.
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
  select: z.enum(['under-chunked', 'stale-embedding-space']).default('under-chunked'),
});

const detectDeps = { db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository } };
const spaceDeps = { db: { fabFiles: fabFileRepository } };

/**
 * The space to compare stored labels against: resolved per DEPLOYMENT (userId `null`), not per
 * caller, because each file is re-embedded under its own OWNER's identity - so the admin clicking
 * this is not whose credentials decide where anything lands.
 *
 * `undefined` means there is no space to compare against, and both verbs below must treat that as a
 * reason to stop rather than as a reason to fall back to the advertised setting. See
 * `resolveEffectiveEmbeddingModel` for the three situations it collapses.
 */
const resolveLakeEmbeddingSpace = () => resolveEffectiveEmbeddingModel(null);

const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    // `failedCount` distinguishes "rebuild finished" from "some files gave up": a failed re-chunk
    // (error set, no chunks) is invisible to detection, so the badge alone would read it as done.
    const embeddingSpace = await resolveLakeEmbeddingSpace();
    const [underChunked, failedCount, stale] = await Promise.all([
      dataLakeService.detectUnderChunkedFiles(lake, detectDeps),
      dataLakeService.countFailedLakeFiles(lake, { db: { fabFiles: fabFileRepository } }),
      embeddingSpace ? dataLakeService.detectStaleEmbeddingSpaceFiles(lake, spaceDeps, embeddingSpace) : null,
    ]);
    return res.json({
      underChunkedCount: underChunked.length,
      failedCount,
      // `null`, never 0, when the space could not be resolved. Zero here reads as "nothing to
      // migrate", and the one case this cannot see is exactly the one where every label comparison
      // would be wrong - so the caller is told it has no answer instead of a reassuring one.
      staleEmbeddingSpaceCount: stale ? stale.length : null,
    });
  })
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query;
    const { limit, select } = RechunkInput.parse(req.body ?? {});
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeRebuildAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    let detected: dataLakeService.LakeRebuildTarget[];
    if (select === 'stale-embedding-space') {
      const embeddingSpace = await resolveLakeEmbeddingSpace();
      if (!embeddingSpace) {
        // 409, where the pause below answers 200 with real counts. That arm detected first and is
        // declining on policy; this one cannot detect at all, so every number it could report would
        // be a guess - and a 200 carrying zeros is indistinguishable from "nothing to migrate".
        // Refusing is also the only safe direction: comparing against the advertised setting
        // instead would select the whole lake on any stage that embeds through the keyless
        // fallback, at full spend, for a wave that can never converge.
        req.logger?.error?.(
          `rechunk: lake ${lake.id} - no resolvable embedding space; re-embed refused before detection`
        );
        // `error` is the body key the client's refusal extractor reads (errorHandler.ts); without it
        // the owner is shown the bare axios string for a 409, which says nothing actionable.
        return res.status(409).json({
          outcome: 'unknown-embedding-space',
          error:
            'This deployment has no resolvable embedding model, so there is no vector space to migrate ' +
            'these files into. Set a supported default embedding model, check that its provider ' +
            'credential is present, then run this again.',
        });
      }
      detected = await dataLakeService.detectStaleEmbeddingSpaceFiles(lake, spaceDeps, embeddingSpace);
    } else {
      detected = await dataLakeService.detectUnderChunkedFiles(lake, detectDeps);
    }
    const wave = detected.slice(0, limit ?? dataLakeService.DEFAULT_REBUILD_WAVE);

    let enqueued = 0;
    if (wave.length > 0) {
      // Kill switch BEFORE the reset, for the reason /converge documents at the same point: the
      // consumer's check only drops messages already on the queue, and by then
      // `resetChunkStateByIds` has deleted this wave's passages and nulled its health rollups. A
      // consumer-side stamp alone cannot protect this route - the destruction happens on the
      // producer side.
      //
      // Gated even though this door repairs rather than converges: it deletes and re-embeds a whole
      // wave at full spend, which is exactly what an operator turning the switch on is trying to
      // stop. Refusing is also recoverable in a way the alternative is not - the files stay
      // searchable and the admin can retry once the switch is off, whereas a wave halted mid-flight
      // leaves them with no passages at all.
      if (
        await isConvergenceHalted(
          { origin: CONVERGENCE_ORIGIN, lakeId: lake.id },
          {
            adminSettings: adminSettingsRepository,
            scopedSettings: scopedSettingsRepository,
            dataLakes: dataLakeRepository,
          },
          req.logger
        )
      ) {
        req.logger?.log?.(
          `[convergence] lake ${lake.id}: background lake work is paused; rechunk refused before touching ${wave.length} member(s)`
        );
        return res.json({
          detected: detected.length,
          enqueued: 0,
          remaining: detected.length,
          outcome: 'paused',
        });
      }

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
      // The cost of routing recovery that way, since the reset above covers the whole wave before
      // any send: the file stays unsearchable until the chunk rescue sweep re-enqueues it - daily
      // 05:00 UTC hosted (infra/cron.ts), ~60s self-host, and only while `enableAutoChunk` is on and
      // convergence work is not paused for the file - either can hold it indefinitely. That pause is
      // not specifically this door's lake: the platform switch, or ANY lake holding the file, can
      // impose it (pickScopedLake). And the refusal above is no protection against it, for two
      // independent reasons - it resolves at request time, so a pause landing after this wave was
      // reset is missed, and it resolves against this lake alone, so a pause already set on a sibling
      // lake holding a member never reaches it. REBUILD_PENDING_STALE_MS (2h) does not gate that
      // sweep; it gates this door's own stale-pending re-detection
      // (findConvergencePausedFilesByScope).
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
        resetIds.map(id =>
          sendToQueue(queueUrl, {
            fabFileId: id,
            userId: userById.get(id)!,
            // Provenance for the #1676 kill switch, matching /converge. The producer gate above is
            // what protects the passages; this is what stops an in-flight wave from continuing to
            // re-embed if the switch is turned on after the messages were sent.
            origin: CONVERGENCE_ORIGIN,
            lakeId: lake.id,
          })
        )
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
