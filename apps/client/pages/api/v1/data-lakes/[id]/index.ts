/**
 * GET /api/v1/data-lakes/{id} - one lake by id or slug, as the public reader projection.
 *
 * Same read gate as GET /api/data-lakes/:id (not-found-style denial, grant-aware), but every
 * caller gets the one narrow `DataLakeResource`: the editor document the SPA serves a manager is
 * not part of the public shape. Auth mode, scopes and path validation come from `getDataLakeContract`.
 */
import { getDataLakeContract } from '@bike4mind/common';
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
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { loadRegistryLakeStats, toPublicDataLake } from '@server/dataLakes/toPublicDataLake';

const handler = nextRouteForContract(getDataLakeContract, {
  rateLimit: rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000 }),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(req.validatedParams.id, ctx, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        settings: adminSettingsRepository,
      },
      logger: req.logger,
    });
    const liveStats = await loadRegistryLakeStats(lake, { fabFiles: fabFileRepository, logger: req.logger });
    return res.json(toPublicDataLake(lake, liveStats));
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
