import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { dataLakeBatchRepository, dataLakeRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { Request } from 'express';

// A single guarded status write, no AI/OpenAI spend involved (unlike apply/reanalyze) - a
// generous hourly cap is enough to bound abuse, no shared daily-cap machinery needed.
const DISMISS_TAXONOMY_HOURLY_CAP = 60;
const HOUR_MS = 60 * 60 * 1000;

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(rateLimit({ limit: DISMISS_TAXONOMY_HOURLY_CAP, windowMs: HOUR_MS, bucket: 'data-lakes/dismiss-taxonomy' }))
  // POST: clear a ready/failed taxonomy batch from the attention list without applying or
  // re-analyzing it. No request body.
  .post(async (req: Request, res) => {
    const { batchId } = req.query as { batchId: string };

    const result = await dataLakeService.dismissTaxonomySuggestion(
      { userId: req.user.id, isAdmin: req.user.isAdmin },
      batchId,
      { db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository } }
    );

    return res.json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
