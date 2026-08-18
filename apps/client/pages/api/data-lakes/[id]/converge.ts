import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { CONVERGENCE_ORIGIN } from '@server/queueHandlers/convergenceProvenance';

/**
 * GET  /api/data-lakes/:id/converge                     -> the plan (a preview; writes nothing)
 * POST /api/data-lakes/:id/converge  { limit, confirm } -> executes one bounded wave
 *
 * Owner-triggered convergence toward the lake's declared chunk policy (#1681). The owner asks; the
 * SYSTEM performs the repair, which is what keeps this out of the lake-scoped-write-grant problem
 * (#1658) - no principal needs write on the lake for its contents to be repaired.
 *
 * Deliberately NOT continuous (epic decision 6). A cron sweeping every lake would mean unattended
 * spend and unattended retrieval outage; whether continuous convergence is worth those is a v2
 * decision, to be taken once health data shows how much drift actually occurs.
 *
 * Three refusals a caller must expect, all reported rather than silently applied:
 *  - `refusal: 'policyInherited'` - the lake has no EXPLICIT chunk policy, so it is measured and
 *    reported by health but never repaired (epic decision 5). Nothing is re-embedded until an owner
 *    adopts a policy.
 *  - `requiresConfirmation` - the run would rewrite more than the operator's share threshold. A mass
 *    rewrite is the signature of a misconfigured policy, and every change inside it looks locally
 *    reasonable; POST refuses until it is re-sent with `confirm: true`.
 *  - `crossLakeConflicts` - members that also belong to a lake requiring a different chunk target.
 *    Repairing them would oscillate between the two lakes, re-embedding and billing on every pass.
 *
 * Enqueues onto the SAME `fabFileChunkQueue` the rest of the chunk path uses - no new queue, DLQ or
 * alarm, because this adds no new background process: v1 has no unattended executor at all. What it
 * does add is provenance: every message is stamped `origin: 'convergence'` + `lakeId`, so the #1676
 * kill switch can halt a wave already on the queue without touching customer uploads.
 *
 * Auth mirrors /rechunk (`assertLakeRebuildAccess`): this re-chunks files already in the lake,
 * attaching nothing and mutating no lake document.
 */

const ConvergeInput = z.object({
  limit: z.number().int().positive().max(dataLakeService.MAX_CONVERGENCE_WAVE).optional(),
  /**
   * Acknowledges the bulk-change guard, and is consulted ONLY when the plan actually trips it - so
   * an ordinary run never has to send it. The guard is an interlock against an unread plan, not an
   * authorization step: a caller that hard-codes `true` has opted out of it, which is why the UI
   * sends it only from a dialog that has rendered the share it is confirming.
   */
  confirm: z.boolean().optional(),
});

const gateDeps = { db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository } };

const convergenceAdapters = async () => {
  const embeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  // Fail loudly rather than planning against a model the chunker will not use: the effective target
  // comparison is model-dependent, so a wrong model here silently mis-classifies every member.
  if (!embeddingModel || !isSupportedEmbeddingModel(embeddingModel)) {
    throw new BadRequestError('Default embedding model not found');
  }
  return {
    db: {
      fabFiles: fabFileRepository,
      dataLakes: dataLakeRepository,
      adminSettings: adminSettingsRepository,
      scopedSettings: scopedSettingsRepository,
    },
    embeddingModel,
  };
};

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const ctx = await toAccessContext(req);
    // Read gate, not the rebuild gate: anyone who can read the lake may see what convergence WOULD
    // do, exactly as they can already see its health. Executing it still requires manage.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, gateDeps);

    const { report } = await dataLakeService.planLakeConvergenceRun(lake, {
      ...(await convergenceAdapters()),
      logger: req.logger,
    });
    return res.json(report);
  })
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const { limit, confirm } = ConvergeInput.parse(req.body ?? {});
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeRebuildAccess(id, ctx, gateDeps);

    const { report, wave } = await dataLakeService.planLakeConvergenceRun(
      lake,
      { ...(await convergenceAdapters()), logger: req.logger },
      limit ?? dataLakeService.DEFAULT_CONVERGENCE_WAVE
    );

    if (report.refusal || (report.requiresConfirmation && !confirm)) {
      // 200 with an explicit outcome, not a 4xx: the plan is the useful part of the answer and the
      // client renders it either way. `enqueued: 0` is the load-bearing field.
      return res.json({ ...report, outcome: report.refusal ?? 'confirmationRequired', detected: 0, enqueued: 0 });
    }

    let enqueued = 0;
    if (wave.length > 0) {
      const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
      if (!queueUrl) throw new Error('Chunk queue URL not found');

      // Reset the wave, then enqueue exactly what the reset changed. The reset is preconditioned on
      // isChunking:{$ne:true} (see resetChunkStateByIds), so a file a worker is mid-run on is skipped
      // rather than having its lease released; `resetIds` is a subset of the wave. Mutual exclusion
      // itself remains the chunk worker's compare-and-set. Same shape as /rechunk on purpose - the
      // two doors must not drift on how a re-chunk is handed off.
      const userById = new Map(wave.map(f => [f.fabFileId, f.userId] as const));
      const resetIds = await fabFileRepository.resetChunkStateByIds([...userById.keys()]);
      const results = await Promise.allSettled(
        resetIds.map(fabFileId =>
          sendToQueue(queueUrl, {
            fabFileId,
            userId: userById.get(fabFileId)!,
            // The whole point: chunk at the LAKE's required target rather than letting the handler
            // re-resolve the file owner's DefaultChunkSize, which is the value that produced the
            // non-conformant chunks in the first place. Without this the re-chunk reproduces exactly
            // what was there and the lake never converges. Sending it is safe only because the
            // cross-lake check already refused every member another lake would disagree about.
            chunkSize: report.policy.requiredTarget,
            // Provenance for the #1676 kill switch: this is background lake work, haltable, and
            // must never be confused with a real-time user upload.
            origin: CONVERGENCE_ORIGIN,
            lakeId: lake.id,
          })
        )
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      const skipped = userById.size - resetIds.length;
      if (failed > 0 || skipped > 0) {
        req.logger?.error?.(
          `convergence: lake ${lake.id} - ${failed}/${resetIds.length} sends failed; ` +
            `${skipped} file(s) skipped as already being chunked`
        );
      }
      enqueued = resetIds.length - failed;
    }

    req.logger?.log?.(
      `[convergence] lake ${lake.id}: enqueued ${enqueued}/${wave.length} member(s) at target ` +
        `${report.policy.requiredTarget} (${report.convergeableCount} off-policy of ${report.membersConsidered} graded, ` +
        `${report.crossLakeConflictCount} refused for cross-lake disagreement)`
    );

    // `noop` is its own outcome, not a zero-count `enqueued`: a lake whose entire remaining drift is
    // cross-lake conflicted returns here on EVERY run, and reporting that as a successful enqueue
    // would have the caller announce a repair that cannot happen and will not happen next time
    // either. The client needs to say why instead.
    return res.json({
      ...report,
      outcome: wave.length === 0 ? 'noop' : 'enqueued',
      detected: wave.length,
      enqueued,
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;
