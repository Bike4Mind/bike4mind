import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  userRepository,
  lakeAccessEventRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { normalizeId } from '@bike4mind/utils/normalizeId';

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
  // "Public" = readable by any SIGNED-IN user, not open to the world: baseApi() authenticates
  // by default, so an unauthenticated caller is rejected with 401 before this handler runs.
  .get(async (req: Request, res) => {
    const { q, limit, offset } = BrowseQuery.parse(req.query);

    const result = await dataLakeService.browsePublicDataLakes(
      await toAccessContext(req),
      { search: q, limit, offset },
      {
        db: {
          dataLakes: dataLakeRepository,
          users: userRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
        },
      }
    );

    // Best-effort audit write - the browsed lakes themselves ARE the result, so no
    // tag-attribution step is needed; every returned lake goes straight into resolvedLakeIds.
    // Deliberately recorded as an access even though it is metadata (name/description), not
    // content: this catalog listing reveals which lakes exist, and data-lake-public-browse is its
    // own surface precisely so a discovery listing here never gets conflated with an actual
    // content read on data-lake-articles/chat-kb-* when someone reads listByLake later. Skipped
    // entirely on an empty page: zero lakes browsed is not a lake access. Awaited (never
    // rethrows): a per-request serverless route must not race a post-response environment freeze.
    if (result.data.length > 0) {
      await dataLakeService.recordLakeAccessEvent(
        lakeAccessEventRepository,
        {
          principalKind: 'user',
          principalId: req.user.id,
          organizationId: normalizeId(req.user.organizationId),
          resolvedLakeIds: result.data.map(lake => lake.id),
          surface: 'data-lake-public-browse',
          ...(q ? { queryText: q } : {}),
        },
        req.logger,
        adminSettingsRepository
      );
    }

    return res.json(result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
