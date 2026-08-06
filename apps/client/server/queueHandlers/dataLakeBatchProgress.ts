import {
  adminSettingsRepository,
  cacheRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import type { IDataLakeBatchDocument, IDataLakeBatchSummary } from '@bike4mind/common';
import { recordBatchCompletion, recordTaxonomyDailyCapExceeded } from '@server/utils/cloudwatch';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import {
  TAXONOMY_DAILY_CAP,
  TAXONOMY_RATE_LIMIT_WINDOW_MS,
  taxonomyRateLimitKey,
} from '@server/dataLakes/taxonomyRateLimit';
import {
  LAKE_MEMORY_DAILY_CAP,
  LAKE_MEMORY_RATE_LIMIT_WINDOW_MS,
  lakeMemoryRateLimitKey,
} from '@server/dataLakes/lakeMemoryRateLimit';
import { isFinalDeliveryAttempt, getDeliveryAttempt } from '@server/queueHandlers/sqsDelivery';
import type { SQSEvent } from 'aws-lambda';
import { Resource } from 'sst';

/**
 * Non-final-attempt guard shared by fabFileChunk.ts/fabFileVectorize.ts's catch blocks: on any
 * SQS delivery that is not the last one before DLQ, log a warning and heartbeat the batch (via
 * touchIfActive, so the read-time stuck-batch reconciler doesn't force it terminal while a retry
 * is still pending) WITHOUT touching file/batch failure state - marking a file 'failed' before a
 * retry gets its chance is unrecoverable, since claimFileStatus's success-path claim can never
 * transition a manifest entry back out of 'failed' (#1412). Returns true when the caller should
 * just rethrow; false means this is the final attempt and the caller should run its normal
 * failure accounting instead.
 */
export async function deferFailureIfRetryable(
  event: SQSEvent,
  maxReceiveCount: number,
  params: {
    fabFileId: string;
    batchId: string | undefined;
    action: string;
    errorMessage: string;
    logger: { warn: (msg: string) => void };
  }
): Promise<boolean> {
  if (isFinalDeliveryAttempt(event, maxReceiveCount)) return false;
  const { fabFileId, batchId, action, errorMessage, logger } = params;
  const attempt = getDeliveryAttempt(event);
  logger.warn(
    `${action} failed for ${fabFileId} on attempt ${attempt}/${maxReceiveCount} (not final - letting SQS retry): ${errorMessage}`
  );
  if (batchId) await dataLakeBatchRepository.touchIfActive(batchId);
  return true;
}

/**
 * Guarded batch finalization shared by the chunk and vectorize handlers. When the
 * completion threshold is crossed, transition the batch terminal via a GUARDED update
 * so exactly one caller wins; the winner recomputes the lake's authoritative stats
 * from SOURCE records (never from the running counters). Safe to call after any
 * counter increment. Also the guaranteed-to-run backstop for the taxonomy-analysis
 * enqueue - see enqueueTaxonomyAnalysisIfWanted's doc comment below.
 */
export async function finalizeBatchIfComplete(
  batch: IDataLakeBatchDocument | null,
  logger: { error: (msg: string) => void }
): Promise<void> {
  if (!batch) return;
  if (batch.vectorizedFiles + batch.failedFiles + batch.skippedFiles < batch.totalFiles) return;

  const outcome = batch.failedFiles > 0 ? 'completed_with_errors' : 'completed';
  const finalized = await dataLakeBatchRepository.markTerminalIfActive(batch.id, outcome);
  if (!finalized) return; // another handler finalized first — don't double-recompute.

  // Parity with the reconciler's forced-terminal metric: record the normal completion once, from
  // the single guarded winner. Emitter never throws (see cloudwatch.ts), belt-and-suspenders .catch.
  await recordBatchCompletion(outcome).catch(() => {});

  try {
    const lake = await dataLakeRepository.findById(batch.dataLakeId);
    if (lake) {
      await dataLakeService.recomputeLakeStats(lake, {
        db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
      });
    }
  } catch (error) {
    logger.error(`Error recomputing lake stats for batch ${batch.id}: ${error}`);
  }

  // Backstop for the primary trigger in upload-complete.ts: if that request never landed
  // (network blip, tab closed) but chunk/vectorize finish here on their own regardless, this
  // is the only other guaranteed-to-run path that can still enqueue taxonomy analysis. Safe to
  // call redundantly with upload-complete.ts's own call - the transition is guarded on 'none'.
  await enqueueTaxonomyAnalysisIfWanted(finalized, logger);

  // Lake memory extraction (#1440 producer) rides the same guaranteed-to-run finalize path. Unlike
  // taxonomy it needs the RAG pipeline done (it reads chunk text), so finalize - not upload-complete -
  // is its trigger. Gated on the EnableLakeMemory admin flag + a per-lake daily cap.
  await enqueueLakeMemoryExtractionIfWanted(finalized, logger);
}

/** True once a batch has reached its completion threshold. */
export function isBatchComplete(batch: IDataLakeBatchDocument | null): boolean {
  return !!batch && batch.vectorizedFiles + batch.failedFiles + batch.skippedFiles >= batch.totalFiles;
}

/**
 * Guarded enqueue for background AI-tag suggestion, opted into at batch-create time.
 * Deliberately NOT gated on ingest (chunk/vectorize) completion: the job only reads file
 * metadata (relativePath/fileName/size/mimeType), which exists as soon as files are uploaded,
 * so it has no real dependency on the RAG pipeline finishing. Called from three places, all
 * safe to call redundantly since the claim below is guarded (`taxonomyStatus` must still be
 * 'none'):
 *   - upload-complete.ts, the primary trigger - fires right after the browser upload phase
 *     ends, regardless of how long chunk/vectorize then takes.
 *   - finalizeBatchIfComplete above, the guaranteed-to-run backstop for when that request
 *     never lands (network blip, tab closed) - chunk/vectorize still finish and finalize the
 *     batch on their own, so this is the only other place left that can still enqueue it.
 *   - the stuck-batch reconciler's forced-terminal path, a further backstop for a batch that
 *     never reached upload-complete OR a terminal chunk/vectorize event at all.
 * Claims BEFORE checking the daily cap (rather than after) so an over-cap batch still lands on
 * a real terminal status instead of being silently left at 'none' forever - every other enqueue
 * failure already gets a 'failed' + a real message, and this one is not exempt. The claim itself
 * has zero cost when it loses (a batch already claimed by a redundant caller above), so checking
 * the cap first would only have saved a rate-limit slot on those already-harmless no-ops.
 */
export async function enqueueTaxonomyAnalysisIfWanted(
  batch: IDataLakeBatchSummary | null,
  logger: { error: (msg: string) => void }
): Promise<void> {
  if (!batch || !batch.wantsTaxonomy) return;

  try {
    const queued = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batch.id, ['none'], 'queued', {
      taxonomyStartedAt: new Date(),
    });
    if (!queued) return;

    // Same daily cap + bucket as the manual reanalyze endpoint (see taxonomyRateLimit.ts) -
    // without this, the automatic path (the actual primary OpenAI-cost driver, firing once
    // per opted-in upload) had no ceiling at all, unlike the deliberately-capped manual path.
    const { success: withinDailyCap } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      taxonomyRateLimitKey(batch.userId),
      TAXONOMY_DAILY_CAP,
      TAXONOMY_RATE_LIMIT_WINDOW_MS
    );
    if (!withinDailyCap) {
      await recordTaxonomyDailyCapExceeded().catch(() => {});
      // Real terminal status with a real message, same as any other enqueue failure - unlike
      // 'none' (which the review UI never surfaces and nothing can claim out of), 'failed' is
      // a legal `from` state for Re-analyze, so this is recoverable once the same shared daily
      // window resets (Re-analyze draws from the identical rate-limit key/bucket, so retrying
      // immediately just trips the same cap again).
      const transitioned = await dataLakeBatchRepository
        .setTaxonomyStatusIfActive(batch.id, ['queued'], 'failed', {
          taxonomyError: 'Daily AI tag-suggestion limit reached - try again tomorrow',
        })
        .catch(() => null);
      // Only notify if THIS call's transition actually won (mirrors analyzeBatchTaxonomy's
      // fail()) - otherwise something else already resolved the phase, and pushing here would
      // contradict whatever that other resolution already told the client.
      if (transitioned) {
        await sendToClient(batch.userId, Resource.websocket.managementEndpoint, {
          action: 'data_lake_batch_progress',
          batchId: batch.id,
          taxonomyStatus: 'failed',
        }).catch(err => logger.error(`Error notifying taxonomy status for batch ${batch.id}: ${err}`));
      }
      return;
    }

    await sendToQueue(Resource.dataLakeTaxonomyQueue.url, {
      batchId: batch.id,
      dataLakeId: batch.dataLakeId,
      userId: batch.userId,
    });
  } catch (error) {
    logger.error(`Error enqueueing taxonomy analysis for batch ${batch.id}: ${error}`);
  }
}

/**
 * Guarded enqueue for lake memory extraction (#1440 producer). Fires on ingest-finalize (a sibling of
 * taxonomy analysis) and is gated on:
 *   - the `EnableLakeMemory` admin flag, off by default - the producer stays dark until an operator
 *     opts a deployment in for the measurement rollout;
 *   - a PER-LAKE daily cap, so a burst of batch finalizes triggers at most a few full-lake extractions.
 * Unlike taxonomy (which only needs file metadata), extraction reads chunk TEXT, so it must run after
 * the chunk/vectorize pipeline finishes - hence finalize, not upload-complete. The job itself is
 * idempotent (the ledger de-dups), so a dropped cap slot only delays a re-scan, never loses data.
 */
export async function enqueueLakeMemoryExtractionIfWanted(
  batch: IDataLakeBatchSummary | null,
  logger: { error: (msg: string) => void }
): Promise<void> {
  if (!batch) return;

  try {
    const enabled = await adminSettingsRepository.getSettingsValue('EnableLakeMemory').catch(() => false);
    if (!enabled) return;

    // Per-lake cap: collapses a burst of finalizes into a bounded number of full-lake extractions.
    const { success: withinCap } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      lakeMemoryRateLimitKey(batch.dataLakeId),
      LAKE_MEMORY_DAILY_CAP,
      LAKE_MEMORY_RATE_LIMIT_WINDOW_MS
    );
    if (!withinCap) return;

    await sendToQueue(Resource.lakeMemoryQueue.url, {
      batchId: batch.id,
      dataLakeId: batch.dataLakeId,
      userId: batch.userId,
    });
  } catch (error) {
    logger.error(`Error enqueueing lake memory extraction for batch ${batch.id}: ${error}`);
  }
}
