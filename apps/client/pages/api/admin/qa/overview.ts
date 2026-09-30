import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import { parseQaFilters } from '@server/qa/filters';
import { getQaOverview } from '@server/qa/reads';

/** GET /api/admin/qa/overview. Tiles, chart series and flaky table for /status. */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  return res.json(await getQaOverview(parseQaFilters(req.query)));
});

export default handler;
