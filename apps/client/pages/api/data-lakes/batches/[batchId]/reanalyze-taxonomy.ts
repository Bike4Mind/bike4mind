import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { isDevelopment } from '@server/utils/config';
import { runTaxonomyInference, sampleFabFilesForTaxonomy } from '@server/dataLakes/runTaxonomyInference';
import {
  ApiKeyType,
  BadRequestError,
  NotFoundError,
  ReanalyzeTaxonomyRequestInput,
  hasDeveloperUserTag,
  sanitizeCategories,
  sanitizeFileAssignments,
} from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { Request } from 'express';

// Same daily cap the pre-upload wizard step enforced (only the call site moved, not the cost
// model): a manual re-analyze is still a real OpenAI spend per click.
export const TAXONOMY_REANALYZE_DAILY_CAP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const resolveTaxonomyDailyLimit = (req: Request): number => {
  if (isDevelopment()) return Infinity;
  if (req.user?.isAdmin || hasDeveloperUserTag(req.user?.tags)) return Infinity;
  return TAXONOMY_REANALYZE_DAILY_CAP;
};

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(rateLimit({ limit: resolveTaxonomyDailyLimit, windowMs: DAY_MS, bucket: 'data-lakes/reanalyze-taxonomy' }))
  // POST: manually re-run AI tag inference for an already-analyzed (or failed) batch.
  .post(async (req: Request, res) => {
    const { batchId } = req.query as { batchId: string };
    const { context } = ReanalyzeTaxonomyRequestInput.parse(req.body);
    const userId = req.user.id;

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch) throw new NotFoundError('Batch not found');

    const lake = await dataLakeRepository.findById(batch.dataLakeId);
    if (!lake) throw new NotFoundError('Data lake not found');
    if (!req.user.isAdmin && lake.createdByUserId !== userId) {
      throw new BadRequestError('Only the creator can re-analyze this batch');
    }

    // Guarded: only re-runs from a state that already finished a prior attempt (successfully
    // or not) - never while a first analysis is still queued/analyzing/applying. Refreshing
    // taxonomyStartedAt here matters: it's the reconciler's only stuck-job clock, and without
    // resetting it a batch re-analyzed well after its original queue time would look
    // instantly stuck to the next poll and get force-failed before this call can finish.
    const claimed = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['ready', 'failed'], 'analyzing', {
      taxonomyStartedAt: new Date(),
    });
    if (!claimed) {
      return res.status(400).json({ error: 'This batch is not in a state that can be re-analyzed right now' });
    }

    const files = await fabFileRepository.findByBatchId(batchId);
    if (files.length === 0) {
      await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['analyzing'], 'failed', {
        taxonomyError: 'No files found for this batch',
      });
      return res.status(400).json({ error: 'No files found for this batch' });
    }

    const openaiApiKey = await apiKeyService.getEffectiveApiKey(
      userId,
      { type: ApiKeyType.openai, nullIfMissing: true },
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
    );
    if (!openaiApiKey) {
      await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['analyzing'], 'failed', {
        taxonomyError: 'No OpenAI API key configured',
      });
      return res.status(400).json({ error: 'No OpenAI API key configured' });
    }

    const folderTree = sampleFabFilesForTaxonomy(files);

    const response = await runTaxonomyInference(openaiApiKey, folderTree, {
      existingPrefix: lake.fileTagPrefix,
      context,
    });
    const tags = sanitizeCategories(response.categories, lake.fileTagPrefix);
    const fileAssignments = sanitizeFileAssignments(response.fileAssignments);

    const updated = await dataLakeBatchRepository.setTaxonomyStatusIfActive(batchId, ['analyzing'], 'ready', {
      taxonomySuggestions: { tags, fileAssignments },
    });

    return res.json(updated);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
