import { canAccessAdmin } from '@bike4mind/common';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { parseQaFilters } from '@server/qa/filters';
import { getQaOverview } from '@server/qa/reads';

/** GET /api/admin/qa/overview. Tiles, chart series and flaky table for /status. */
const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  ensureAdmin(canAccessAdmin(req.user));
  return res.json(await getQaOverview(parseQaFilters(req.query)));
});

export default handler;
