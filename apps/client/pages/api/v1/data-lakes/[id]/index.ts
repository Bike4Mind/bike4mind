/**
 * GET /api/v1/data-lakes/{id} - one lake by id or slug, as the public reader projection.
 *
 * Same read gate as GET /api/data-lakes/:id (not-found-style denial, grant-aware), but every
 * caller gets the one narrow `DataLakeResource`: the editor document the SPA serves a manager is
 * not part of the public shape. Auth mode, scopes and path validation come from `getDataLakeContract`.
 *
 * Member-scoped (`toMemberAccessContext`), matching GET /api/v1/data-lakes: a platform admin who is
 * not a member of this lake gets the same 404 as anyone else. The public API has no way to tell an
 * integrator which lakes are theirs versus merely administered, so it never grants the admin bypass.
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
import { toMemberAccessContext } from '@server/dataLakes/toAccessContext';
import { loadRegistryLakeStats, toPublicDataLake } from '@server/dataLakes/toPublicDataLake';

const handler = nextRouteForContract(getDataLakeContract, {
  rateLimit: rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user),
    windowMs: 60 * 1000,
    // Required: the raw pathname embeds `id`, so without a stable bucket each lake gets its own
    // counter instead of one budget per caller.
    bucket: '/api/v1/data-lakes/[id]',
  }),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const ctx = await toMemberAccessContext(req);
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
