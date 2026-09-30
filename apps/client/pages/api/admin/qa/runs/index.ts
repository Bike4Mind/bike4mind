import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { parseQaFilters } from '@server/qa/filters';
import { listQaRuns } from '@server/qa/reads';

/** GET /api/admin/qa/runs?<filters>&before=<iso>. Newest-first run list, 50 per page. */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const filters = parseQaFilters(req.query);
  let before: Date | undefined;
  if (typeof req.query.before === 'string') {
    before = new Date(req.query.before);
    if (Number.isNaN(before.getTime())) throw new BadRequestError('before must be an ISO timestamp');
  }
  return res.json(await listQaRuns(filters, before ? { before } : {}));
});

export default handler;
