/**
 * The un-chunked rescue sweep, in ONE place.
 *
 * Safety net for a lost ingest event (the MinIO webhook on self-host, S3 ObjectCreated on hosted) or
 * for an upload that landed while auto-chunk was off: re-enqueue files that completed upload but were
 * never chunked, so they stop being silently unsearchable. Selection lives in chunkScan.ts.
 *
 * Both drivers call this - the self-host worker's 60-second `fabFileChunkScan` task and the hosted
 * daily `dataLakeBatchReconcile` cron. They differ ONLY in their run budget (50 per tick vs 500 per
 * day), which is why that is the argument and nothing else is. They used to be two functions kept
 * aligned by a "MUST STAY IN SYNC" notice, on the grounds that the hosted one folds its counts into
 * the cron's response body; that does not need a separate function, since both already return the
 * same `{ enqueued, failed }` for the caller to do as it likes with. The divergence that notice
 * warned about had already happened - a #2126 review found the self-host copy had no test of its own,
 * so dropping an argument there regressed nothing visible while the cron's test stayed green.
 *
 * Lives in its own module rather than inline in main.ts so the enqueue accounting is reachable from a
 * test at all: as a scheduled-task closure it was unexported and unnameable.
 */

import { adminSettingsRepository, dataLakeRepository, FabFile, scopedSettingsRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { sendToQueue } from '@server/utils/sqs';
import { buildFabFileChunkScanFilter, CHUNK_SCAN_MIN_AGE_MS, CHUNK_CLAIM_STALE_MS } from './chunkScan';
import {
  buildChunkRescueMessage,
  resolveConvergencePauseScope,
  toChunkScanConvergencePause,
} from '@server/dataLakes/convergencePauseScope';

/**
 * How many rescue sends are in flight at once, matching driveLakeResyncPoll's sweep.
 * The bound is what makes the per-file catch below safe: sendToQueue builds a fresh SQSClient per
 * call (server/utils/sqs.ts), so its retry token bucket never throttles down across the loop and
 * every failed send pays its full attempt budget with no back-off. Run one-at-a-time against a
 * degraded queue, a self-host tick's worth of those can outlast the scheduler's 60s tick - and the worker's
 * scheduled tasks are non-reentrant (selfHostWorker.ts), so an overrunning tick doesn't queue up,
 * it makes the next one a skip. Removing the early exit without bounding the wall-clock would trade
 * "abandons the tail" for "runs half as often exactly when it is needed most".
 */
const ENQUEUE_CONCURRENCY = 10;

export interface ChunkRescueSweepOptions {
  /** Per-run cap on files enqueued, so a large backlog drains gradually. The only thing the two drivers differ on. */
  limit: number;
  logger: Logger;
}

export async function runChunkRescueSweep({
  limit,
  logger: runLogger,
}: ChunkRescueSweepOptions): Promise<{ enqueued: number; failed: number }> {
  if (!(await adminSettingsRepository.getSettingsValue('enableAutoChunk'))) return { enqueued: 0, failed: 0 };

  const now = Date.now();
  const cutoff = new Date(now - CHUNK_SCAN_MIN_AGE_MS);
  const staleClaimBefore = new Date(now - CHUNK_CLAIM_STALE_MS);
  // The run's pause picture: the platform switch plus, ONLY when an override actually exists, the
  // lakes whose effective flag disagrees with it. Feeds both halves - see convergencePauseScope.ts
  // for why the selection clause is a cap-fairness optimisation and the enqueue below is the gate.
  const pauseScope = await resolveConvergencePauseScope(
    {
      adminSettings: adminSettingsRepository,
      scopedSettings: scopedSettingsRepository,
      dataLakes: dataLakeRepository,
    },
    runLogger
  );
  const candidates = await FabFile.find(
    buildFabFileChunkScanFilter(cutoff, staleClaimBefore, {
      convergencePause: toChunkScanConvergencePause(pauseScope),
    })
  )
    // `tags` only when a scoped override exists: it is the sole input to the per-file lake resolution
    // below, and with no override every lake resolves to the platform value anyway, so the wider
    // projection would be paid on every run for nothing.
    .select(pauseScope.scopedLakes.length > 0 ? '_id userId tags' : '_id userId')
    .limit(limit)
    .lean();

  // Enqueue the selected ids directly. No producer-side claim: the chunk worker's compare-and-set
  // (fabFileChunk.ts) is the single point of mutual exclusion, so a file already in flight loses
  // there and returns. The selection filter above already excludes in-flight files, so a merely-slow
  // file is not re-sent every pass.
  const byId = new Map(candidates.map(f => [String(f._id), f]));

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
      await sendToQueue(queueUrl, buildChunkRescueMessage(byId.get(id)!, pauseScope));
      enqueued++;
    } catch (e) {
      failed++;
      runLogger.error('[fabFileChunkScan] failed to enqueue un-chunked file for rescue', {
        fabFileId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += ENQUEUE_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + ENQUEUE_CONCURRENCY).map(id => enqueueOne(id)));
  }

  // A failed send changes nothing about the file, so it still matches the scan filter and a later
  // tick retries it - a minute away, not a day. Not necessarily the NEXT one: the candidate query
  // has no sort, so while the backlog exceeds the run budget a given file is only eventually
  // reached. `failed` is a signal that sends are being lost, not a marker of work dropped for good.
  // Logged only when the tick did something, so an idle install stays quiet - but a tick that
  // enqueued nothing BECAUSE every send failed still reports, which is the case worth seeing.
  if (enqueued > 0 || failed > 0) {
    runLogger.info(`[fabFileChunkScan] enqueued ${enqueued} un-chunked file(s), ${failed} failed`);
  }
  return { enqueued, failed };
}
