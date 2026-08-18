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
  adminSettingsRepository,
  connectDB,
  dataLakeBatchRepository,
  dataLakeRepository,
  FabFile,
  fabFileRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { recordReconcilerForcedTerminal, recordStuckBatchGauge, recordReconcileRun } from '@server/utils/cloudwatch';
import { enqueueTaxonomyAnalysisIfWanted } from '@server/queueHandlers/dataLakeBatchProgress';
import { buildFabFileChunkScanFilter, CHUNK_SCAN_MIN_AGE_MS, CHUNK_CLAIM_STALE_MS } from '@server/worker/chunkScan';
import { CONVERGENCE_ORIGIN } from '@server/queueHandlers/convergenceProvenance';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'dataLakeBatchReconcile' } });

const MAX_PER_RUN = 500;
/** Cap per daily run for the un-chunked rescue sweep; a large backlog drains gradually. */
const CHUNK_RESCUE_MAX_PER_RUN = 500;

/**
 * Hosted counterpart of the self-host worker's fabFileChunkScan (worker/main.ts): re-enqueue
 * files that completed upload but were never chunked, so they stop being silently unsearchable
 * (#1420 - e.g. uploads that landed while enableAutoChunk was off, or whose S3 event was lost).
 * The shared filter excludes terminal outcomes (no-text note, chunk error), so a file is swept
 * at most once per cause; a repeat appearance means the queue message itself was lost.
 */
async function rescueUnchunkedFiles(): Promise<number> {
  if (!(await adminSettingsRepository.getSettingsValue('enableAutoChunk'))) return 0;

  const now = Date.now();
  const cutoff = new Date(now - CHUNK_SCAN_MIN_AGE_MS);
  const staleClaimBefore = new Date(now - CHUNK_CLAIM_STALE_MS);
  const candidates = await FabFile.find(buildFabFileChunkScanFilter(cutoff, staleClaimBefore))
    .select('_id userId batchId')
    .limit(CHUNK_RESCUE_MAX_PER_RUN)
    .lean();

  // Enqueue the selected ids directly. No producer-side claim: the chunk worker's compare-and-set
  // (fabFileChunk.ts) is the single point of mutual exclusion, so a file already in flight loses
  // there and returns. The selection filter above already excludes in-flight files, so a merely-slow
  // file is not re-sent every pass.
  const userById = new Map(candidates.map(f => [String(f._id), String(f.userId)]));
  const batchById = new Map(candidates.map(f => [String(f._id), f.batchId]));
  for (const id of userById.keys()) {
    await sendToQueue(Resource.fabFileChunkQueue.url, {
      fabFileId: id,
      userId: userById.get(id)!,
      ...(batchById.get(id) ? { origin: CONVERGENCE_ORIGIN } : {}),
    });
  }
  return userById.size;
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
    db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository },
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
  const rescuedChunkFiles = await rescueUnchunkedFiles().catch(err => {
    logger.error(`[DataLakeBatchReconcile] un-chunked rescue sweep failed: ${err}`);
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
  });
  return {
    statusCode: 200,
    body: JSON.stringify({
      candidates,
      forced: forced.length,
      taxonomyCandidates: stuckTaxonomy.length,
      taxonomyForced: forcedTaxonomy.length,
      rescuedChunkFiles,
    }),
  };
}
