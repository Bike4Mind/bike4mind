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
  adminSettingsRepository,
  FabFile,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import {
  recordReconcilerForcedTerminal,
  recordStuckBatchGauge,
  recordReconcileRun,
  recordChunkRescueSweep,
  type ChunkRescueOutcome,
} from '@server/utils/cloudwatch';
import { enqueueTaxonomyAnalysisIfWanted } from '@server/queueHandlers/dataLakeBatchProgress';
import { runChunkRescueSweep } from '@server/worker/chunkRescueSweep';
import { runModerationRescueSweep } from '@server/s3/moderationRescueSweep';
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
/** Cap per daily run for the moderation rescue sweep; stranded files are rare so this is a safety net. */
const MODERATION_RESCUE_MAX_PER_RUN = 200;

/**
 * How many stranded-vectorize sends are in flight at once, matching the bound the un-chunked sweep
 * and driveLakeResyncPoll already use. sendToQueue builds a fresh SQSClient per call
 * (server/utils/sqs.ts), so its retry token bucket never throttles down across the loop and every
 * failed send pays its full attempt budget with no back-off. Run one-at-a-time against a degraded
 * queue, CHUNK_RESCUE_MAX_PER_RUN of those is a wall-clock cost this handler cannot absorb - it is
 * the LAST of three sweeps in one 10-minute Lambda, so the tail is what gets cut off.
 */
const ENQUEUE_CONCURRENCY = 10;

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

  // Bounded-concurrency fan-out with a PER-FILE catch: one throttled or unroutable send must cost
  // only itself, not abandon every candidate behind it (the same lesson driveLakeResyncPoll
  // learned). A recovery sweep is the worst place for that, since it runs precisely when the queue
  // is under the stress that makes a transient send failure likely - which is also why the sends
  // are bounded rather than sequential, see ENQUEUE_CONCURRENCY. Returns the SENT count so a
  // partially-failing run is distinguishable from a clean one in the log.
  // Read the queue URL once: an unlinked-resource fault is one config error, not a log per file.
  const queueUrl = Resource.fabFileChunkQueue.url;
  let sent = 0;
  const sendOne = async (file: (typeof candidates)[number]) => {
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
      await sendToQueue(queueUrl, {
        fabFileId: String(file._id),
        userId: String(file.userId),
      });
      sent += 1;
    } catch (err) {
      logger.error(`[DataLakeBatchReconcile] stranded-vectorize rescue send failed for ${file._id}: ${err}`);
    }
  };
  for (let i = 0; i < candidates.length; i += ENQUEUE_CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + ENQUEUE_CONCURRENCY).map(file => sendOne(file)));
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

  // Isolated so a rescue failure never blocks the batch reconciliation above. The sweep names its
  // own outcome ('disabled' | 'swept'); a throw never gets that far, so 'failed' is ours to report
  // - without it this catch would return the same zeroes as a healthy idle tick.
  const chunkRescue: { outcome: ChunkRescueOutcome; enqueued: number; failed: number } = await runChunkRescueSweep({
    limit: CHUNK_RESCUE_MAX_PER_RUN,
    logger,
  }).catch(err => {
    logger.error(`[DataLakeBatchReconcile] un-chunked rescue sweep failed: ${err}`);
    return { outcome: 'failed' as const, enqueued: 0, failed: 0 };
  });
  const { outcome: rescueOutcome, enqueued: rescuedChunkFiles, failed: rescueFailures } = chunkRescue;
  await recordChunkRescueSweep(rescueOutcome, rescuedChunkFiles, rescueFailures).catch(() => {});
  const rescuedVectorizeFiles = await rescueStrandedVectorizeFiles().catch(err => {
    logger.error(`[DataLakeBatchReconcile] stranded-vectorize rescue sweep failed: ${err}`);
    return 0;
  });

  // Isolated like the sweeps above: re-scan FabFiles whose moderation scan never completed (a
  // transient import-scan failure, or an upload whose objectCreated scan exhausted its retries),
  // so a stranded 'pending' file does not stay unservable forever.
  const { rescanned: rescannedModerationFiles } = await runModerationRescueSweep({
    enabled:
      getSettingsValue(
        'ImageModerationEnabled',
        // Guard the settings read itself: it is awaited as an ARGUMENT to the sweep, evaluated
        // before the .catch() below is attached, so a settings/DB blip here would otherwise reject
        // out of the whole tick. Default to moderation ON (fail-closed) if the read fails.
        await getSettingsMap({ adminSettings: adminSettingsRepository }).catch(() => ({}))
      ) ?? true,
    limit: MODERATION_RESCUE_MAX_PER_RUN,
    logger,
  }).catch(err => {
    logger.error(`[DataLakeBatchReconcile] moderation rescue sweep failed: ${err}`);
    return { rescanned: 0 };
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
    rescueOutcome,
    rescannedModerationFiles,
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
      rescueOutcome,
      rescannedModerationFiles,
    }),
  };
}
