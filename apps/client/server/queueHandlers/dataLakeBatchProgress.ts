import { cacheRepository, dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import type { IDataLakeBatchDocument } from '@bike4mind/common';
import { recordBatchCompletion } from '@server/utils/cloudwatch';
import { sendToQueue } from '@server/utils/sqs';
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
 * counter increment.
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
}

/** True once a batch has reached its completion threshold. */
export function isBatchComplete(batch: IDataLakeBatchDocument | null): boolean {
  return !!batch && batch.vectorizedFiles + batch.failedFiles + batch.skippedFiles >= batch.totalFiles;
}

/**
 * Guarded enqueue for background AI-tag suggestion, opted into at batch-create time.
 * Deliberately NOT gated on ingest (chunk/vectorize) completion: the job only reads file
 * metadata (relativePath/fileName/size/mimeType), which exists as soon as files are uploaded,
 * so it has no real dependency on the RAG pipeline finishing. Called from two places, both
 * safe to call redundantly since the transition is guarded (`taxonomyStatus` must still be
 * 'none'):
 *   - upload-complete.ts, the primary trigger - fires right after the browser upload phase
 *     ends, regardless of how long chunk/vectorize then takes.
 *   - the stuck-batch reconciler's forced-terminal path, as a backstop for a batch that
 *     never reached upload-complete (e.g. the tab closed mid-upload) - that path bypasses
 *     finalizeBatchIfComplete entirely, so it needs its own call to this function.
 * Non-blocking: a failure to enqueue leaves taxonomyStatus at 'none', which the review UI
 * simply never surfaces - it does not affect the batch's own ingest outcome.
 */
export async function enqueueTaxonomyAnalysisIfWanted(
  batch: IDataLakeBatchDocument | null,
  logger: { error: (msg: string) => void }
): Promise<void> {
  if (!batch || !batch.wantsTaxonomy) return;

  try {
    // Same daily cap + bucket as the manual reanalyze endpoint (see taxonomyRateLimit.ts) -
    // without this, the automatic path (the actual primary OpenAI-cost driver, firing once
    // per opted-in upload) had no ceiling at all, unlike the deliberately-capped manual path.
    // Checked before the claim so a blocked batch has zero side effects, same as any other
    // enqueue failure below: it stays at 'none', which the review UI simply never surfaces.
    const { success: withinDailyCap } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      taxonomyRateLimitKey(batch.userId),
      TAXONOMY_DAILY_CAP,
      TAXONOMY_RATE_LIMIT_WINDOW_MS
    );
    if (!withinDailyCap) return;

    const queued = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batch.id, ['none'], 'queued', {
      taxonomyStartedAt: new Date(),
    });
    if (queued) {
      await sendToQueue(Resource.dataLakeTaxonomyQueue.url, {
        batchId: batch.id,
        dataLakeId: batch.dataLakeId,
        userId: batch.userId,
      });
    }
  } catch (error) {
    logger.error(`Error enqueueing taxonomy analysis for batch ${batch.id}: ${error}`);
  }
}
