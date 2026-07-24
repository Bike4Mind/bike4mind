import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, userRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';

// Coerce + clamp the browse query. Strings arrive from the query string; empty search is
// dropped so it isn't sent to the repo as a no-op regex. Paging bounds mirror the repo clamp.
const BrowseQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET /api/data-lakes/public - browse the public-lake discovery catalog (search + paging).
  .get(async (req: Request, res) => {
    const { q, limit, offset } = BrowseQuery.parse(req.query);

    const result = await dataLakeService.browsePublicDataLakes(
      { userId: req.user.id, isAdmin: !!req.user.isAdmin },
      { search: q, limit, offset },
      { db: { dataLakes: dataLakeRepository, users: userRepository } }
    );

    return res.json(result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
