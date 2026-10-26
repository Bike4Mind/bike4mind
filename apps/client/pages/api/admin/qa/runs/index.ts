import { canAccessAdmin } from '@bike4mind/common';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { parseQaFilters } from '@server/qa/filters';
import { listQaRuns } from '@server/qa/reads';

/** GET /api/admin/qa/runs?<filters>&before=<iso>. Newest-first run list, 50 per page. */
const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  ensureAdmin(canAccessAdmin(req.user));
  const filters = parseQaFilters(req.query);
  let before: Date | undefined;
  if (typeof req.query.before === 'string') {
    before = new Date(req.query.before);
    if (Number.isNaN(before.getTime())) throw new BadRequestError('before must be an ISO timestamp');
  }
  return res.json(await listQaRuns(filters, before ? { before } : {}));
});

export default handler;
