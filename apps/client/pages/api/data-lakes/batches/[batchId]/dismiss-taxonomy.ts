import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  withTransaction,
  dataLakeBatchRepository,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
} from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { dataLakeService } from '@bike4mind/services';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

// A single guarded status write, no AI/OpenAI spend involved (unlike apply/reanalyze) - a
// generous hourly cap is enough to bound abuse, no shared daily-cap machinery needed.
const DISMISS_TAXONOMY_HOURLY_CAP = 60;
const HOUR_MS = 60 * 60 * 1000;

const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(rateLimit({ limit: DISMISS_TAXONOMY_HOURLY_CAP, windowMs: HOUR_MS, bucket: 'data-lakes/dismiss-taxonomy' }))
  // POST: clear a ready/failed taxonomy batch from the attention list without applying or
  // re-analyzing it. No request body.
  .post(async (req: Request, res) => {
    const { batchId } = req.query as { batchId: string };

    const ctx = await toAccessContext(req);
    // The service gates on the batch's lake itself; running it inside the transaction is what lets a
    // grant revoke committing mid-request collide on the lake doc and re-run the gate.
    const result = await withTransaction(async () => {
      const dismissal = await dataLakeService.dismissTaxonomySuggestion(ctx, batchId, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          batches: dataLakeBatchRepository,
        },
      });

      // The service returns only { success }, so the lake id comes from a re-read of the batch it just gated on.
      const batch = await dataLakeBatchRepository.findById(batchId);
      if (!batch) throw new NotFoundError('Batch not found');
      // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
      await dataLakeRepository.touchIfStable(batch.dataLakeId);
      return dismissal;
    });

    return res.json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
