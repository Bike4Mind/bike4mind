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
import { buildFabFileChunkScanFilter, CHUNK_SCAN_MIN_AGE_MS } from '@server/worker/chunkScan';
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

  const cutoff = new Date(Date.now() - CHUNK_SCAN_MIN_AGE_MS);
  const candidates = await FabFile.find(buildFabFileChunkScanFilter(cutoff))
    .select('_id userId')
    .limit(CHUNK_RESCUE_MAX_PER_RUN)
    .lean();

  for (const file of candidates) {
    await sendToQueue(Resource.fabFileChunkQueue.url, {
      fabFileId: String(file._id),
      userId: file.userId,
    });
  }
  return candidates.length;
}

export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const timeoutMs = dataLakeService.DEFAULT_STUCK_BATCH_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - timeoutMs);
  const stuck = await dataLakeBatchRepository.findStuck(cutoff, MAX_PER_RUN);

  const forced = await dataLakeService.reconcileStuckBatches(stuck, timeoutMs, {
    db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository },
    logger,
    metrics: {
      // Also backstops the taxonomy enqueue for a batch that never reached upload-complete
      // NOR a terminal chunk/vectorize event (finalizeBatchIfComplete already backstops the
      // latter case) - this daily sweep is the last chance to catch a genuinely stuck batch
      // (the read-time reconciler in batches/index.ts is the faster backstop for the same gap).
      emitForcedTerminal: batch =>
        Promise.all([
          recordReconcilerForcedTerminal().catch(() => {}),
          enqueueTaxonomyAnalysisIfWanted(batch, logger).catch(() => {}),
        ]).then(() => {}),
      emitStuckGauge: count => recordStuckBatchGauge(count).catch(() => {}),
    },
  });

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
    candidates: stuck.length,
    forced: forced.length,
    taxonomyCandidates: stuckTaxonomy.length,
    taxonomyForced: forcedTaxonomy.length,
    rescuedChunkFiles,
  });
  return {
    statusCode: 200,
    body: JSON.stringify({
      candidates: stuck.length,
      forced: forced.length,
      taxonomyCandidates: stuckTaxonomy.length,
      taxonomyForced: forcedTaxonomy.length,
      rescuedChunkFiles,
    }),
  };
}
