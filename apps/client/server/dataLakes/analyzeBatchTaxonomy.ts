import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import {
  ApiKeyType,
  sanitizeCategories,
  sanitizeFileAssignments,
  type IDataLakeBatchDocument,
  type TaxonomyStatus,
} from '@bike4mind/common';
import { sendToClient } from '@server/websocket/utils';
import { runTaxonomyInference, sampleFabFilesForTaxonomy } from '@server/dataLakes/runTaxonomyInference';
import { Resource } from 'sst';

export interface AnalyzeBatchTaxonomyResult {
  /** False if the guarded claim lost - the batch wasn't in one of `from`'s states. Every
   * other field is only meaningful when this is true. */
  claimed: boolean;
  outcome?: 'ready' | 'failed';
  /** Present when outcome is 'failed' - also stored as the batch's taxonomyError. */
  error?: string;
  /** Present when outcome is 'ready' - the batch document with its fresh taxonomySuggestions. */
  batch?: IDataLakeBatchDocument;
}

/**
 * Shared claim -> sample -> infer -> sanitize -> store -> notify orchestration for background
 * AI-tag-suggestion analysis. Used by both the automatic post-upload queue handler
 * (`dataLakeTaxonomyAnalysis`) and the manual re-analyze endpoint, so both share one code
 * path, one WebSocket-notification behavior, and one claim/finalize discipline instead of two
 * independently-drifting ~45-line copies.
 *
 * Anticipated failures (no files, no API key, no lake) are handled internally: the batch is
 * transitioned to 'failed' with a real message and the client is notified. An UNEXPECTED
 * exception (DB/network/inference-call error) is left to THROW rather than being swallowed
 * here, because the right recovery differs per caller: the queue handler wants to release the
 * claim so SQS can actually retry; the manual endpoint has no retry mechanism and wants to
 * surface an immediate error to the requester instead. Both callers must catch it themselves.
 *
 * `runTaxonomyInference` throws for a genuine API-call failure (see its doc comment) - that's
 * deliberately left in this "unexpected exception" bucket rather than caught and routed through
 * `fail()` here, so the queue handler's existing claim-release-then-rethrow path can give it a
 * real automatic SQS retry (a transient 429/5xx is exactly the kind of failure retry helps
 * with). Note this still can't clobber a prior-good `taxonomySuggestions`: neither caller's own
 * catch touches that field either - the queue handler only resets `taxonomyStatus`, and the
 * manual endpoint only sets `taxonomyStatus`/`taxonomyError`.
 */
export async function analyzeBatchTaxonomy(
  batchId: string,
  dataLakeId: string,
  userId: string,
  logger: { error: (msg: string) => void },
  options: { from: TaxonomyStatus[]; context?: string }
): Promise<AnalyzeBatchTaxonomyResult> {
  // Refresh taxonomyStartedAt on the claim itself, not just on later transitions - the
  // stuck-job reconciler's clock must start from when THIS attempt began, not an earlier
  // enqueue/prior-attempt time, or a claim that sat briefly in queue (or was redelivered)
  // could look instantly stuck and get force-failed mid-run.
  const claimed = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, options.from, 'analyzing', {
    taxonomyStartedAt: new Date(),
  });
  if (!claimed) return { claimed: false };

  const notify = (taxonomyStatus: 'ready' | 'failed') =>
    sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'data_lake_batch_progress',
      batchId,
      taxonomyStatus,
    }).catch(err => logger.error(`Error notifying taxonomy status for batch ${batchId}: ${err}`));

  const fail = async (message: string): Promise<AnalyzeBatchTaxonomyResult> => {
    const transitioned = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['analyzing'], 'failed', {
      taxonomyError: message,
    });
    // Only notify if THIS call's transition actually won - otherwise something else (most
    // likely the stuck-job reconciler) already resolved the phase concurrently, and this
    // notify would contradict whatever that other resolution already told the client.
    if (transitioned) await notify('failed');
    return { claimed: true, outcome: 'failed', error: message };
  };

  const files = await fabFileRepository.findByBatchId(batchId);
  if (files.length === 0) return fail('No files found for this batch');

  const openaiApiKey = await apiKeyService.getEffectiveApiKey(
    userId,
    { type: ApiKeyType.openai, nullIfMissing: true },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );
  if (!openaiApiKey) return fail('No OpenAI API key configured');

  // The lake's tag prefix is already fixed pre-upload (derived from the name, same as the
  // non-AI path) - inference is told to use it rather than proposing a competing namespace
  // this post-upload flow has no way to adopt.
  const lake = await dataLakeRepository.findById(dataLakeId);
  if (!lake) return fail('Data lake not found');

  const folderTree = sampleFabFilesForTaxonomy(files);
  const response = await runTaxonomyInference(openaiApiKey, folderTree, {
    existingPrefix: lake.fileTagPrefix,
    context: options.context,
  });

  const tags = sanitizeCategories(response.categories, lake.fileTagPrefix);
  const fileAssignments = sanitizeFileAssignments(response.fileAssignments);

  const finalized = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['analyzing'], 'ready', {
    taxonomySuggestions: { tags, fileAssignments },
  });
  if (!finalized) {
    // Lost the race (e.g. the reconciler force-failed this batch while inference was in
    // flight) - the computed suggestions are intentionally discarded rather than overwriting
    // whatever resolved the phase first; the batch's actual stored status is authoritative.
    return { claimed: true, outcome: 'failed', error: 'Batch status changed before analysis could complete' };
  }
  await notify('ready');
  return { claimed: true, outcome: 'ready', batch: finalized };
}
