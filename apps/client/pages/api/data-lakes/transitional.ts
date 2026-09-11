import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, adminSettingsRepository } from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

// GET /api/data-lakes/transitional - lakes stranded mid-lifecycle, for whoever can retry them
// (manage-scoped and cutoff-filtered in the service; see listTransitionalDataLakes).
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const dataLakes = await dataLakeService.listTransitionalDataLakes(await toAccessContext(req), {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        settings: adminSettingsRepository,
      },
    });
    return res.json({ data: dataLakes });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
