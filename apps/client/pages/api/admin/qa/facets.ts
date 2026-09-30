import { ApiKeyScope, QA_SLUG_PATTERN } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import { getQaFacets } from '@server/qa/reads';

/** GET /api/admin/qa/facets?product= . Filter options for /status. */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const raw = req.query.product;
  const product = typeof raw === 'string' && QA_SLUG_PATTERN.test(raw) ? raw : undefined;
  return res.json(await getQaFacets(product));
});

export default handler;
