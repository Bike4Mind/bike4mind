import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { isDevelopment } from '@server/utils/config';
import { analyzeBatchTaxonomy } from '@server/dataLakes/analyzeBatchTaxonomy';
import {
  TAXONOMY_DAILY_CAP,
  TAXONOMY_RATE_LIMIT_BUCKET,
  TAXONOMY_RATE_LIMIT_WINDOW_MS,
} from '@server/dataLakes/taxonomyRateLimit';
import { BadRequestError, NotFoundError, ReanalyzeTaxonomyRequestInput, hasDeveloperUserTag } from '@bike4mind/common';
import { dataLakeBatchRepository, dataLakeRepository } from '@bike4mind/database';
import { Request } from 'express';

// Shared with the automatic post-upload trigger (see taxonomyRateLimit.ts) - a manual
// re-analyze is still a real OpenAI spend per click, same as the automatic path.
const resolveTaxonomyDailyLimit = (req: Request): number => {
  if (isDevelopment()) return Infinity;
  if (req.user?.isAdmin || hasDeveloperUserTag(req.user?.tags)) return Infinity;
  return TAXONOMY_DAILY_CAP;
};

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(
    rateLimit({
      limit: resolveTaxonomyDailyLimit,
      windowMs: TAXONOMY_RATE_LIMIT_WINDOW_MS,
      bucket: TAXONOMY_RATE_LIMIT_BUCKET,
    })
  )
  // POST: manually re-run AI tag inference for an already-analyzed (or failed) batch. Shares
  // its claim/sample/infer/store/notify orchestration with the automatic post-upload queue
  // handler via analyzeBatchTaxonomy - see that function for the guarded-claim details.
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

    let result;
    try {
      // Only re-runs from a state that already finished a prior attempt (successfully or
      // not) - never while a first analysis is still queued/analyzing/applying.
      result = await analyzeBatchTaxonomy(batchId, batch.dataLakeId, userId, req.logger, {
        from: ['ready', 'failed'],
        context,
      });
    } catch (error) {
      // Unlike the queue handler, there's no SQS retry available on this synchronous
      // request/response path - surface the real failure immediately (with a real message)
      // instead of leaving the batch stuck in 'analyzing' until the reconciler force-fails
      // it with a generic "Timed out" message ~10 minutes later.
      await dataLakeBatchRepository
        .setTaxonomyStatusIfActive(batchId, ['analyzing'], 'failed', {
          taxonomyError: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
      throw error;
    }

    if (!result.claimed) {
      return res.status(400).json({ error: 'This batch is not in a state that can be re-analyzed right now' });
    }
    if (result.outcome === 'failed') {
      return res.status(400).json({ error: result.error });
    }

    return res.json(result.batch);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
