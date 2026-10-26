import { canAccessAdmin } from '@bike4mind/common';
import { ApiKeyScope, QA_SLUG_PATTERN } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { getQaFacets } from '@server/qa/reads';

/** GET /api/admin/qa/facets?product= . Filter options for /status. */
const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  ensureAdmin(canAccessAdmin(req.user));
  const raw = req.query.product;
  const product = typeof raw === 'string' && QA_SLUG_PATTERN.test(raw) ? raw : undefined;
  return res.json(await getQaFacets(product));
});

export default handler;
