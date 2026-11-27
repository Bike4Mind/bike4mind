import { adminApi } from '@server/middlewares/adminApi';
import { cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { buildTimeline } from '@server/admin/spendExplorer/spendExplorer';
import { SPEND_EXPLORER_CACHE_MS, TimelineQuerySchema, spendExplorerCacheKey } from '@server/admin/spendExplorer/query';

/**
 * GET /api/admin/spend-explorer/timeline - recorded AI cost (UsageEvent.costUsd) per
 * UTC hour or day, split by one dimension, with a rolling-median baseline, spike
 * flags, the previous period's totals and suspension markers. Optional
 * userId narrows it to the calls one user ran, whoever paid for them. Aggregated server-side; never ships rows.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const parsed = TimelineQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');
  const { recache, userId, ...rest } = parsed.data;
  const query = { ...rest, actorUserId: userId };

  const data = await cacheService.getCachedData(spendExplorerCacheKey('timeline', query), () => buildTimeline(query), {
    db: { caches: cacheRepository },
    expiry: SPEND_EXPLORER_CACHE_MS,
    recache,
    logger: req.logger,
  });
  return res.json(data);
});

export default handler;
