/**
 * Data Lake Batch Reconcile (daily fallback)
 *
 * The read-time reconciler (`/api/data-lakes/batches`) only fires when a user opens their batch
 * list, so a batch that goes stuck while nobody looks stays non-terminal indefinitely. This cron
 * is the global fallback: it scans ALL users' non-terminal batches idle past the timeout and
 * forces them terminal via the same guarded `reconcileStuckBatches` service.
 *
 * Safe alongside the read-time path: `markTerminalIfActive` is a guarded single-winner transition,
 * so a race between the two just makes the loser a no-op. Idempotent across runs (forced batches
 * leave the non-terminal set), capped per run so it stays inside the Lambda timeout.
 *
 * runStuckBatchSweep is also the self-host worker's counterpart (worker/main.ts) - self-host has
 * no SST cron, so it drives the same sweep off its own scheduled-task interval.
 *
 * Schedule: daily. Enabled: production + dev.
 */

import {
  connectDB,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileRepository,
  FabFile,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { recordReconcilerForcedTerminal, recordStuckBatchGauge, recordReconcileRun } from '@server/utils/cloudwatch';
import { enqueueTaxonomyAnalysisIfWanted } from '@server/queueHandlers/dataLakeBatchProgress';
import { runChunkRescueSweep } from '@server/worker/chunkRescueSweep';
import {
  buildStrandedVectorizeScanFilter,
  CHUNK_CLAIM_STALE_MS,
  VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS,
} from '@server/worker/chunkScan';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';

const logger = new Logger({ metadata: { service: 'dataLakeBatchReconcile' } });

const MAX_PER_RUN = 500;
/** Cap per daily run for the un-chunked rescue sweep; a large backlog drains gradually. */
const CHUNK_RESCUE_MAX_PER_RUN = 500;

/**
 * Hosted counterpart of the same second pass in the self-host worker's fabFileChunkScan: files
 * whose chunks were committed but whose vectorize hand-off failed. Re-enqueueing a chunk message
 * resumes only the fan-out (see buildStrandedVectorizeScanFilter and fabFileChunk.ts) - it never
 * re-chunks. Not gated on enableAutoChunk: these files were already chunked.
 */
async function rescueStrandedVectorizeFiles(): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS);
  const staleClaimBefore = new Date(now - CHUNK_CLAIM_STALE_MS);
  const candidates = await FabFile.find(buildStrandedVectorizeScanFilter(cutoff, staleClaimBefore))
    .select('_id userId')
    .limit(CHUNK_RESCUE_MAX_PER_RUN)
    .lean();

  // Per-send catch, not a bare sequential loop: one throttled or unroutable send must cost only
  // itself, not abandon every candidate behind it (the same lesson driveLakeResyncPoll learned). A
  // recovery sweep is the worst place for that, since it runs precisely when the queue is under the
  // stress that makes a transient send failure likely. Returns the SENT count so a partially-failing
  // tick is distinguishable from a clean one in the log.
  let sent = 0;
  for (const file of candidates) {
    try {
      // Deliberately UNSTAMPED, unlike the un-chunked sweep above (#2309): these files are already
      // chunked, and the handler's halt branch (fabFileChunk.ts, isConvergenceHalted) runs ABOVE the
      // already-chunked resume. Stamping `origin: convergence` would therefore route a healthy
      // chunked file into that branch with the switch on, writing `chunkStallReason: 'rechunkPaused'`
      // and nulling `chunkRebuildRequestedAt` over committed passages, then throwing - so the resume
      // never runs, `vectorizeEnqueueFailedAt` is never cleared, and this sweep re-sends the file
      // every tick until each message has burned its retry ladder into the DLQ. The un-chunked sweep
      // is safe to stamp because its filter carries a convergence-pause exclusion and its files have
      // no chunks to damage; this filter has no paused-file exclusion, which is what would make the
      // re-fire unbounded rather than one-shot. Finishing an already-committed hand-off is not the
      // background work the kill switch exists to stop.
      await sendToQueue(Resource.fabFileChunkQueue.url, {
        fabFileId: String(file._id),
        userId: String(file.userId),
      });
      sent += 1;
    } catch (err) {
      logger.error(`[DataLakeBatchReconcile] stranded-vectorize rescue send failed for ${file._id}: ${err}`);
    }
  }
  return sent;
}

/**
 * Find + reconcile stuck data-lake batches. The hosted daily cron (handler(), below) and the
 * self-host worker's scheduled task (worker/main.ts) both come through here, so the two drivers
 * run the exact same stuck-batch logic rather than the self-host path drifting from the cron.
 */
export async function runStuckBatchSweep(runLogger: Logger): Promise<{ candidates: number; forced: string[] }> {
  const timeoutMs = dataLakeService.DEFAULT_STUCK_BATCH_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - timeoutMs);
  const stuck = await dataLakeBatchRepository.findStuck(cutoff, MAX_PER_RUN);

  const forced = await dataLakeService.reconcileStuckBatches(stuck, timeoutMs, {
    // Audit repos wired: this reconciler forces terminal the batches that never reached
    // finalizeBatchIfComplete, so it is the only path that can activate those lakes.
    db: {
      dataLakes: dataLakeRepository,
      batches: dataLakeBatchRepository,
      fabFiles: fabFileRepository,
      ...lakeConfigAuditDb,
    },
    logger: runLogger,
    metrics: {
      // Also backstops the taxonomy enqueue for a batch that never reached upload-complete
      // NOR a terminal chunk/vectorize event (finalizeBatchIfComplete already backstops the
      // latter case) - this daily sweep is the last chance to catch a genuinely stuck batch
      // (the read-time reconciler in batches/index.ts is the faster backstop for the same gap).
      emitForcedTerminal: batch =>
        Promise.all([
          recordReconcilerForcedTerminal().catch(() => {}),
          enqueueTaxonomyAnalysisIfWanted(batch, runLogger).catch(() => {}),
        ]).then(() => {}),
      emitStuckGauge: count => recordStuckBatchGauge(count).catch(() => {}),
    },
  });

  return { candidates: stuck.length, forced };
}

export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const { candidates, forced } = await runStuckBatchSweep(logger);

  // Global fallback for the background AI-tagging phase - the read-time reconciler
  // (10-minute timeout) is the primary backstop; this daily sweep catches a stuck job on a
  // lake nobody has reopened since.
  const taxonomyTimeoutMs = dataLakeService.DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS;
  const taxonomyCutoff = new Date(Date.now() - taxonomyTimeoutMs);
  const stuckTaxonomy = await dataLakeBatchRepository.findStuckTaxonomy(taxonomyCutoff, MAX_PER_RUN);
  const forcedTaxonomy = await dataLakeService.reconcileStuckTaxonomy(stuckTaxonomy, taxonomyTimeoutMs, {
    db: { batches: dataLakeBatchRepository },
    logger,
  });

  // Isolated so a rescue failure never blocks the batch reconciliation above.
  const { enqueued: rescuedChunkFiles, failed: rescueFailures } = await runChunkRescueSweep({
    limit: CHUNK_RESCUE_MAX_PER_RUN,
    logger,
  }).catch(err => {
    logger.error(`[DataLakeBatchReconcile] un-chunked rescue sweep failed: ${err}`);
    return { enqueued: 0, failed: 0 };
  });
  const rescuedVectorizeFiles = await rescueStrandedVectorizeFiles().catch(err => {
    logger.error(`[DataLakeBatchReconcile] stranded-vectorize rescue sweep failed: ${err}`);
    return 0;
  });

  // Heartbeat every run (even zero-work) so a stopped/broken cron alarms on absence of data.
  await recordReconcileRun().catch(() => {});

  logger.info('[DataLakeBatchReconcile] Sweep complete', {
    candidates,
    forced: forced.length,
    taxonomyCandidates: stuckTaxonomy.length,
    taxonomyForced: forcedTaxonomy.length,
    rescuedChunkFiles,
    rescuedVectorizeFiles,
    rescueFailures,
  });
  return {
    statusCode: 200,
    body: JSON.stringify({
      candidates,
      forced: forced.length,
      taxonomyCandidates: stuckTaxonomy.length,
      taxonomyForced: forcedTaxonomy.length,
      rescuedChunkFiles,
      rescuedVectorizeFiles,
      rescueFailures,
    }),
  };
}
