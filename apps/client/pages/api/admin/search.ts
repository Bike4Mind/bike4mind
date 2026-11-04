import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { AdminSearchQuerySchema } from '@client/app/utils/adminEntitySearch';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { classifyAdminQuery } from '@server/admin/search/classifyQuery';
import { searchAdminEntities } from '@server/admin/search/searchEntities';

const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'admin-entity-search' }))
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    res.setHeader('Cache-Control', 'no-store');
    const { q } = parseOrBadRequest(AdminSearchQuerySchema, req.query);
    const kind = classifyAdminQuery(q);
    if (kind === 'ip' || kind === 'keyPrefix') {
      await recordAdminActionFromRequest(req, {
        action: 'admin.search.performed',
        target: { kind: 'system', id: 'admin-search', displayName: 'Admin search' },
        summary: 'Searched admin identifiers',
        details: { identifierType: kind },
      });
    }
    return res.json({ results: await searchAdminEntities(q) });
  });

export default handler;
