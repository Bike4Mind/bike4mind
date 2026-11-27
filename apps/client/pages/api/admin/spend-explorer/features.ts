import { adminApi } from '@server/middlewares/adminApi';
import { cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { buildFeatures } from '@server/admin/spendExplorer/featureCost';
import { FeaturesQuerySchema, SPEND_EXPLORER_CACHE_MS, spendExplorerCacheKey } from '@server/admin/spendExplorer/query';

/**
 * GET /api/admin/spend-explorer/features - per-feature requests, failures, distinct users,
 * credits, recorded cost (failed rows excluded), share, units, daily cost and a last-day
 * spike flag over whole UTC days [from, to). `audience` (all / external / internal) uses the
 * Analytics account rule; optional userId narrows it to the calls one user ran.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const parsed = FeaturesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');
  const { recache, userId, ...rest } = parsed.data;
  const query = { ...rest, actorUserId: userId };

  const data = await cacheService.getCachedData(spendExplorerCacheKey('features', query), () => buildFeatures(query), {
    db: { caches: cacheRepository },
    expiry: SPEND_EXPLORER_CACHE_MS,
    recache,
    logger: req.logger,
  });
  return res.json(data);
});

export default handler;
