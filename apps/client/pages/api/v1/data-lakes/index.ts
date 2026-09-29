/**
 * GET /api/v1/data-lakes - the public, cursor-paginated twin of GET /api/data-lakes.
 *
 * Lists the caller's MEMBER reach (toMemberAccessContext): an admin key sees its owner's own
 * lakes, not every tenant's, because the public shape has no way to tell an integrator which
 * lakes are theirs and which they merely administer. Auth mode, scopes and query validation
 * come from `listDataLakesContract`.
 */
import { listDataLakesContract, type IDataLakeDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { paginateById } from '@server/utils/cursorPagination';
import { toMemberAccessContext } from '@server/dataLakes/toAccessContext';
import { loadRegistryLakeStats, toPublicDataLake } from '@server/dataLakes/toPublicDataLake';

const CURSOR_SCOPE = 'v1.data-lakes';

const handler = nextRouteForContract(listDataLakesContract, {
  rateLimit: rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000 }),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const { limit, cursor } = req.validatedQuery;
    const ctx = await toMemberAccessContext(req);
    const lakes = await dataLakeService.listDataLakes(ctx, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        settings: adminSettingsRepository,
      },
    });
    const page = paginateById(lakes, { limit, cursor, scope: CURSOR_SCOPE });

    // The list rows are configs without the counts and timestamps the public shape carries, so
    // re-read just this page's documents; a built-in lake has none and is counted live instead.
    const dbLakeIds = page.items.filter(lake => !dataLakeService.isFallbackLake(lake)).map(lake => lake.id);
    const documents: IDataLakeDocument[] =
      dbLakeIds.length > 0 ? await dataLakeRepository.find({ _id: { $in: dbLakeIds } }) : [];
    const documentsById = new Map(documents.map(doc => [doc.id, doc]));

    const data = await Promise.all(
      page.items.map(async lake => {
        const liveStats = await loadRegistryLakeStats(lake, { fabFiles: fabFileRepository, logger: req.logger });
        return toPublicDataLake(documentsById.get(lake.id) ?? lake, liveStats);
      })
    );

    return res.json({ data, next_cursor: page.nextCursor });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
