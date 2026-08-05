import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { ApplyTaxonomyRequestInput } from '@bike4mind/common';
import { Request } from 'express';

// The guarded 'ready' -> 'applying' claim already means only one apply per completed
// analysis can succeed, but a rejected call still costs a batch + lake lookup, and this
// can be combined with reanalyze-taxonomy's daily cap to repeat a full-batch write many
// times a day. Matches the sibling reanalyze-taxonomy endpoint's rate-limit pattern.
const APPLY_TAXONOMY_HOURLY_CAP = 60;
const HOUR_MS = 60 * 60 * 1000;

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(rateLimit({ limit: APPLY_TAXONOMY_HOURLY_CAP, windowMs: HOUR_MS, bucket: 'data-lakes/apply-taxonomy' }))
  // POST: apply the reviewed/edited AI tag suggestions to every matching file in the batch.
  .post(async (req: Request, res) => {
    const { batchId } = req.query as { batchId: string };
    const data = ApplyTaxonomyRequestInput.parse(req.body);

    const result = await dataLakeService.applyTaxonomySuggestions(
      { userId: req.user.id, isAdmin: req.user.isAdmin },
      batchId,
      data.tags.filter(t => !t.deleted),
      {
        db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository },
        logger: console,
      }
    );

    return res.json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
