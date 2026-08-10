import { dataLakeBatchRepository } from '@bike4mind/database';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { analyzeBatchTaxonomy } from '@server/dataLakes/analyzeBatchTaxonomy';
import { z, ZodError } from 'zod';

const AnalyzeTaxonomyPayload = z.object({
  batchId: z.string(),
  dataLakeId: z.string(),
  userId: z.string(),
});

/**
 * Background AI-taxonomy analysis for a data-lake batch, triggered once by
 * `finalizeBatchIfComplete` after upload/chunk/vectorize finish (never blocks upload; it's
 * an opt-in enrichment). See `analyzeBatchTaxonomy` for the shared claim/sample/infer/store/
 * notify orchestration - also used by the manual re-analyze endpoint.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  let batchId: string | undefined;
  try {
    const payload = AnalyzeTaxonomyPayload.parse(JSON.parse(event.Records[0].body));
    batchId = payload.batchId;
    logger.updateMetadata({ handler: 'dataLakeTaxonomyAnalysis', batchId: payload.batchId, userId: payload.userId });

    const result = await analyzeBatchTaxonomy(payload.batchId, payload.dataLakeId, payload.userId, logger, {
      from: ['queued'],
    });
    if (!result.claimed) {
      logger.log(`Batch ${payload.batchId} taxonomy phase already claimed/finalized - skipping`);
    }
  } catch (err) {
    // Permanently-invalid message (malformed payload) - retrying can't fix it.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping taxonomy analysis message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Unexpected DB/network/inference error mid-analysis: release the claim back to 'queued'
    // so the SQS redelivery can actually re-claim and retry. Without this, the guarded claim
    // in analyzeBatchTaxonomy leaves the batch at 'analyzing', which blocks every retry
    // attempt (they all see a non-'queued' status and silently no-op), so the real error was
    // never actually retried and the batch only reached 'failed' ~10 minutes later via the
    // reconciler's generic "Timed out" message - discarding the real cause.
    // Also refresh taxonomyStartedAt here, matching the claim's own refresh: the stuck-job
    // reconciler's staleness guard now runs off this clock, so leaving it at the original
    // claim's timestamp would let a batch waiting between ordinary SQS redeliveries (up to
    // ~2x the 6-minute visibility timeout) read as stale and get force-failed mid-retry.
    if (batchId) {
      await dataLakeBatchRepository
        .setTaxonomyStatusIfActive(batchId, ['analyzing'], 'queued', { taxonomyStartedAt: new Date() })
        .catch(() => {});
    }
    throw err; // DB/network - let SQS retry, then DLQ.
  }
});
