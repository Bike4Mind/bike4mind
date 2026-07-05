import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository } from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

// GET /api/data-lakes/archived - archived lakes accessible to the user (management view)
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const dataLakes = await dataLakeService.listArchivedDataLakes(await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository },
    });
    return res.json({ data: dataLakes });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
