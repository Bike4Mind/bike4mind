import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { ApplyTaxonomyRequestInput } from '@bike4mind/common';
import { Request } from 'express';

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // POST: apply the reviewed/edited AI tag suggestions to every matching file in the batch.
  .post(async (req: Request, res) => {
    const { batchId } = req.query as { batchId: string };
    const data = ApplyTaxonomyRequestInput.parse(req.body);

    const result = await dataLakeService.applyTaxonomySuggestions(
      { userId: req.user.id, isAdmin: req.user.isAdmin },
      batchId,
      data.tags.filter(t => !t.deleted),
      { db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository } }
    );

    return res.json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
