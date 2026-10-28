import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { parseQaFilters } from '@server/qa/filters';
import { getQaOverview } from '@server/qa/reads';

/** GET /api/admin/qa/overview. Tiles, chart series and flaky table for /status. */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  return res.json(await getQaOverview(parseQaFilters(req.query)));
});

export default handler;
