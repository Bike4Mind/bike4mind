import { adminApi } from '@server/middlewares/adminApi';
import { parseQaSummaryFilters } from '@server/qa/filters';
import { getQaSummary } from '@server/qa/reads';

/** GET /api/admin/qa/summary. Per-product pass rates of scheduled runs over the range, for /status. */
const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { GET: 'support:read' },
}).get(async (req, res) => {
  return res.json(await getQaSummary(parseQaSummaryFilters(req.query)));
});

export default handler;
