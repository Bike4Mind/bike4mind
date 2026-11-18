import { adminApi } from '@server/middlewares/adminApi';
import { cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { buildAccounts } from '@server/admin/spendExplorer/spendExplorer';
import { AccountsQuerySchema, SPEND_EXPLORER_CACHE_MS, spendExplorerCacheKey } from '@server/admin/spendExplorer/query';

/**
 * GET /api/admin/spend-explorer/accounts - for [from, to): total recorded cost, the
 * provider and internal/partner/customer cuts, and the top `limit` accounts with
 * name, segment, share and age. With compareFrom/compareTo, flags accounts in this
 * window's top 10 that were not in the comparison window's.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const parsed = AccountsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');
  const { recache, compareFrom, compareTo, ...rest } = parsed.data;
  const query = { ...rest, compare: compareFrom && compareTo ? { from: compareFrom, to: compareTo } : undefined };

  const data = await cacheService.getCachedData(spendExplorerCacheKey('accounts', query), () => buildAccounts(query), {
    db: { caches: cacheRepository },
    expiry: SPEND_EXPLORER_CACHE_MS,
    recache,
    logger: req.logger,
  });
  return res.json(data);
});

export default handler;
