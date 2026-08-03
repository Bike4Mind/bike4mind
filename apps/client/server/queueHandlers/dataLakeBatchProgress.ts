import { cacheRepository, dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import type { IDataLakeBatchDocument } from '@bike4mind/common';
import { recordBatchCompletion, recordTaxonomyDailyCapExceeded } from '@server/utils/cloudwatch';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import {
  TAXONOMY_DAILY_CAP,
  TAXONOMY_RATE_LIMIT_WINDOW_MS,
  taxonomyRateLimitKey,
} from '@server/dataLakes/taxonomyRateLimit';
import { Resource } from 'sst';

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
  batch: IDataLakeBatchDocument | null,
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
      // Real terminal status with a real message, same as any other enqueue failure - a
      // rate-limited batch is recoverable via Re-analyze ('failed' is a legal `from` state),
      // unlike 'none' which the review UI never surfaces and nothing can claim out of.
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
