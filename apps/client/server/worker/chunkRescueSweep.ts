/**
 * Self-host drivers for the two chunk-queue rescue sweeps: un-chunked files, and files whose
 * vectorize hand-off was stranded. Both run from the same `fabFileChunkScan` scheduled task.
 *
 * Safety net for the MinIO webhook (pages/api/internal/s3/object-created.ts): if a notification is
 * missed, re-enqueue files that completed upload but were never chunked so they stop being silently
 * unsearchable. Selection lives in chunkScan.ts and is shared with the hosted twin.
 *
 * MUST STAY IN SYNC with `rescueUnchunkedFiles` in server/cron/dataLakeBatchReconcile.ts - the
 * hosted deployment has no self-host worker and drives the same sweep off its daily SST cron. Their
 * run budgets are meant to differ (50 per tick every 60s here vs 500 per day there); nothing else
 * is, so a behavioural change to one belongs in both. They are still two functions because the
 * hosted one folds its counts into the cron's response body and heartbeat metric, which have no
 * analogue here - the divergence risk that buys is exactly what this notice is for.
 *
 * Lives in its own module rather than inline in main.ts so the enqueue accounting is reachable from
 * a test at all: as a scheduled-task closure it was unexported and unnameable.
 */

import { adminSettingsRepository, FabFile } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { sendToQueue } from '@server/utils/sqs';
import { CONVERGENCE_ORIGIN } from '@server/queueHandlers/convergenceProvenance';
import {
  buildFabFileChunkScanFilter,
  buildStrandedVectorizeScanFilter,
  CHUNK_SCAN_BATCH,
  CHUNK_SCAN_MIN_AGE_MS,
  CHUNK_CLAIM_STALE_MS,
  VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS,
} from './chunkScan';

/**
 * How many rescue sends are in flight at once, matching driveLakeResyncPoll's sweep.
 * The bound is what makes the per-file catch below safe: sendToQueue builds a fresh SQSClient per
 * call (server/utils/sqs.ts), so its retry token bucket never throttles down across the loop and
 * every failed send pays its full attempt budget with no back-off. Run one-at-a-time against a
 * degraded queue, CHUNK_SCAN_BATCH of those can outlast the scheduler's 60s tick - and the worker's
 * scheduled tasks are non-reentrant (selfHostWorker.ts), so an overrunning tick doesn't queue up,
 * it makes the next one a skip. Removing the early exit without bounding the wall-clock would trade
 * "abandons the tail" for "runs half as often exactly when it is needed most".
 */
const ENQUEUE_CONCURRENCY = 10;

export async function runChunkRescueSweep(runLogger: Logger): Promise<{ enqueued: number; failed: number }> {
  if (!(await adminSettingsRepository.getSettingsValue('enableAutoChunk'))) return { enqueued: 0, failed: 0 };

  const now = Date.now();
  const cutoff = new Date(now - CHUNK_SCAN_MIN_AGE_MS);
  const staleClaimBefore = new Date(now - CHUNK_CLAIM_STALE_MS);
  const candidates = await FabFile.find(buildFabFileChunkScanFilter(cutoff, staleClaimBefore))
    .select('_id userId batchId')
    .limit(CHUNK_SCAN_BATCH)
    .lean();

  // Enqueue the selected ids directly. No producer-side claim: the chunk worker's compare-and-set
  // (fabFileChunk.ts) is the single point of mutual exclusion, so a file already in flight loses
  // there and returns. The selection filter above already excludes in-flight files, so a merely-slow
  // file is not re-sent every pass.
  const userById = new Map(candidates.map(f => [String(f._id), String(f.userId)]));
  const batchById = new Map(candidates.map(f => [String(f._id), f.batchId]));

  // Bounded-concurrency fan-out with a PER-FILE catch. A throttled or unroutable send used to reject
  // out of a sequential loop and abandon every candidate behind it, and the count reported was the
  // selected size rather than the sent size. This sweep is the safety net for files the chunk
  // pipeline lost, so it matters most under exactly the queue stress that makes a transient send
  // failure likely - the failure mode was to give up when it was needed most.
  // Read the queue URL once: an unlinked-resource fault is one config error, not 50 identical logs.
  const queueUrl = Resource.fabFileChunkQueue.url;
  let enqueued = 0;
  let failed = 0;
  const enqueueOne = async (id: string) => {
    try {
      await sendToQueue(queueUrl, {
        fabFileId: id,
        userId: userById.get(id)!,
        ...(batchById.get(id) ? { origin: CONVERGENCE_ORIGIN } : {}),
      });
      enqueued++;
    } catch (e) {
      failed++;
      runLogger.error('[fabFileChunkScan] failed to enqueue un-chunked file for rescue', {
        fabFileId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const ids = [...userById.keys()];
  for (let i = 0; i < ids.length; i += ENQUEUE_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + ENQUEUE_CONCURRENCY).map(id => enqueueOne(id)));
  }

  // A failed send changes nothing about the file, so it still matches the scan filter and a later
  // tick retries it - a minute away, not a day. Not necessarily the NEXT one: the candidate query
  // has no sort, so while the backlog exceeds CHUNK_SCAN_BATCH a given file is only eventually
  // reached. `failed` is a signal that sends are being lost, not a marker of work dropped for good.
  // Logged only when the tick did something, so an idle install stays quiet - but a tick that
  // enqueued nothing BECAUSE every send failed still reports, which is the case worth seeing.
  if (enqueued > 0 || failed > 0) {
    runLogger.info(`[fabFileChunkScan] enqueued ${enqueued} un-chunked file(s), ${failed} failed`);
  }
  return { enqueued, failed };
}

/**
 * Second pass of the same scheduled task: files whose chunks landed but whose vectorize hand-off
 * failed. Ungated by enableAutoChunk - these files are already chunked, so the setting has nothing
 * left to gate - and separately capped, see buildStrandedVectorizeScanFilter. Returns the SENT
 * count, so a partially-failing tick is distinguishable from a clean one.
 *
 * MUST STAY IN SYNC with `rescueStrandedVectorizeFiles` in server/cron/dataLakeBatchReconcile.ts -
 * the hosted deployment has no self-host worker and drives the same sweep off its daily SST cron.
 * Their run budgets are meant to differ; nothing else is, so a behavioural change to one belongs in
 * both. Same split, and same reason, as runChunkRescueSweep and its hosted twin above.
 */
export async function runStrandedVectorizeRescue(runLogger: Logger): Promise<number> {
  const cutoff = new Date(Date.now() - VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS);
  const candidates = await FabFile.find(buildStrandedVectorizeScanFilter(cutoff))
    .select('_id userId batchId')
    .limit(CHUNK_SCAN_BATCH)
    .lean();

  // Per-send catch so one throttled or unroutable send costs only itself: this is the last pass of
  // a scheduled task, so an escaping rejection would abandon every candidate behind it AND fail the
  // whole tick.
  let sent = 0;
  for (const file of candidates) {
    try {
      await sendToQueue(Resource.fabFileChunkQueue.url, {
        fabFileId: String(file._id),
        userId: String(file.userId),
        ...(file.batchId ? { origin: CONVERGENCE_ORIGIN } : {}),
      });
      sent += 1;
    } catch (err) {
      runLogger.error(`[fabFileChunkScan] stranded-vectorize re-enqueue failed for ${file._id}: ${err}`);
    }
  }
  if (sent > 0) {
    runLogger.info(`[fabFileChunkScan] re-enqueued ${sent} file(s) with a stranded vectorize hand-off`);
  }
  return sent;
}
