import { adminApi } from '@server/middlewares/adminApi';
import { cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { buildFeatureUsers } from '@server/admin/spendExplorer/featureCost';
import {
  FeatureUsersQuerySchema,
  SPEND_EXPLORER_CACHE_MS,
  spendExplorerCacheKey,
} from '@server/admin/spendExplorer/query';

/**
 * GET /api/admin/spend-explorer/feature-users - one page (limit/offset) of the acting users
 * of one feature over whole UTC days [from, to), by recorded cost, with their requests,
 * failures, credits, units, share of the feature and last-day spike flag.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const parsed = FeatureUsersQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');
  const { recache, ...query } = parsed.data;

  const data = await cacheService.getCachedData(
    spendExplorerCacheKey('feature-users', query),
    () => buildFeatureUsers(query),
    { db: { caches: cacheRepository }, expiry: SPEND_EXPLORER_CACHE_MS, recache, logger: req.logger }
  );
  return res.json(data);
});

export default handler;
