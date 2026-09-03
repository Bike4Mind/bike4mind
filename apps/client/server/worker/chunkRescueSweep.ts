/**
 * Self-host drivers for the two chunk-queue rescue sweeps: un-chunked files, and files whose
 * vectorize hand-off was stranded. Both run from the same `fabFileChunkScan` scheduled task.
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

import { adminSettingsRepository, DataLakeModel, FabFile, scopedSettingsRepository } from '@bike4mind/database';
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
import {
  buildChunkRescueMessage,
  PAUSABLE_LAKE_FIELDS,
  resolveConvergencePauseScope,
  resolvePlatformOnlyMembership,
  toChunkScanConvergencePause,
  type PausableLake,
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

/**
 * The pause map's lake read, projected and lean rather than through `dataLakeRepository.find`: an
 * Owner- or Organization-rung override reaches every lake under that principal, and none of a lake
 * document's prose, stats or settings is read. `virtuals: true` is what yields the `id` the grading
 * keys on (mongoose-lean-virtuals is registered globally in @bike4mind/database).
 */
const findPausableLakes = (filter: Record<string, unknown>): Promise<PausableLake[]> =>
  DataLakeModel.find(filter).select(PAUSABLE_LAKE_FIELDS).lean({ virtuals: true }) as unknown as Promise<
    PausableLake[]
  >;

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
      findPausableLakes,
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

  // The gate's second half, and the only part that needs the candidates: with the platform switch ON
  // and some lake exempted back to running, a candidate can also belong to a lake NO override
  // reaches - which is paused, and whose passages a re-chunk would rewrite. Deliberately after the
  // selection query (it is keyed on what came back) and deliberately not feeding it: being selected
  // only costs a cap slot, being enqueued costs the write. A no-op on every other run.
  const enqueueScope = await resolvePlatformOnlyMembership(pauseScope, candidates, { findPausableLakes }, runLogger);

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
      await sendToQueue(queueUrl, buildChunkRescueMessage(byId.get(id)!, enqueueScope));
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
  const now = Date.now();
  const cutoff = new Date(now - VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS);
  const staleClaimBefore = new Date(now - CHUNK_CLAIM_STALE_MS);
  const candidates = await FabFile.find(buildStrandedVectorizeScanFilter(cutoff, staleClaimBefore))
    .select('_id userId batchId')
    .limit(CHUNK_SCAN_BATCH)
    .lean();

  // Per-send catch so one throttled or unroutable send costs only itself: this is the last pass of
  // a scheduled task, so an escaping rejection would abandon every candidate behind it AND fail the
  // whole tick.
  // Sequential, unlike the ENQUEUE_CONCURRENCY fan-out above - that bound does NOT apply here. It
  // stays sequential to match the hosted twin, so bounding it is a change that belongs in both
  // rather than a self-host-only edit. Worth knowing if that is ever revisited: this pass shares
  // the 60s non-reentrant tick with runChunkRescueSweep, so the worst case the ENQUEUE_CONCURRENCY
  // docblock describes is both passes' CHUNK_SCAN_BATCH inside one tick's budget.
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
