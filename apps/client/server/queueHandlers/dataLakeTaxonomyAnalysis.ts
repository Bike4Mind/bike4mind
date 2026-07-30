import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { ApiKeyType, sanitizeCategories, sanitizeFileAssignments } from '@bike4mind/common';
import { sendToClient } from '@server/websocket/utils';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { runTaxonomyInference, sampleFabFilesForTaxonomy } from '@server/dataLakes/runTaxonomyInference';
import { z, ZodError } from 'zod';
import { Resource } from 'sst';

const AnalyzeTaxonomyPayload = z.object({
  batchId: z.string(),
  dataLakeId: z.string(),
  userId: z.string(),
});

/**
 * Background AI-taxonomy analysis for a data-lake batch, triggered once by
 * `finalizeBatchIfComplete` after upload/chunk/vectorize finish (never blocks upload; it's
 * an opt-in enrichment). Samples already-uploaded FabFiles by metadata (relativePath/
 * fileName/mimeType/fileSize - no content re-read from storage in v1), runs the same
 * inference prompt the old pre-upload wizard step used, and stores the sanitized result on
 * the batch for the list's review panel to pick up.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  try {
    const { batchId, dataLakeId, userId } = AnalyzeTaxonomyPayload.parse(JSON.parse(event.Records[0].body));
    logger.updateMetadata({ handler: 'dataLakeTaxonomyAnalysis', batchId, userId });

    // Guarded claim: only the first delivery to see 'queued' proceeds. A redelivery (or a
    // message that arrives after the reconciler already forced 'failed') is a no-op.
    const claimed = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['queued'], 'analyzing');
    if (!claimed) {
      logger.log(`Batch ${batchId} taxonomy phase already claimed/finalized - skipping`);
      return;
    }

    const notify = (taxonomyStatus: 'ready' | 'failed') =>
      sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'data_lake_batch_progress',
        batchId,
        taxonomyStatus,
      }).catch(err => logger.error(`Error notifying taxonomy status for batch ${batchId}: ${err}`));

    const fail = async (message: string) => {
      await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['analyzing'], 'failed', {
        taxonomyError: message,
      });
      await notify('failed');
    };

    const files = await fabFileRepository.findByBatchId(batchId);
    if (files.length === 0) {
      await fail('No files found for this batch');
      return;
    }

    const openaiApiKey = await apiKeyService.getEffectiveApiKey(
      userId,
      { type: ApiKeyType.openai, nullIfMissing: true },
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
    );
    if (!openaiApiKey) {
      await fail('No OpenAI API key configured');
      return;
    }

    // The lake's tag prefix is already fixed pre-upload (derived from the name, same as the
    // non-AI path) - inference is told to use it rather than proposing a competing namespace
    // this post-upload flow has no way to adopt.
    const lake = await dataLakeRepository.findById(dataLakeId);
    if (!lake) {
      await fail('Data lake not found');
      return;
    }

    const folderTree = sampleFabFilesForTaxonomy(files);
    const response = await runTaxonomyInference(openaiApiKey, folderTree, { existingPrefix: lake.fileTagPrefix });

    const tags = sanitizeCategories(response.categories, lake.fileTagPrefix);
    const fileAssignments = sanitizeFileAssignments(response.fileAssignments);

    await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['analyzing'], 'ready', {
      taxonomySuggestions: { tags, fileAssignments },
    });
    await notify('ready');
  } catch (err) {
    // Permanently-invalid message (malformed payload) - retrying can't fix it.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping taxonomy analysis message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB/network - let SQS retry, then DLQ.
  }
});
