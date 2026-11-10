import { ApiKeyScope } from '@bike4mind/common';
import { modelDiscoveryService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { loadAdminModelRows, parseAdminModelListQuery } from '@server/admin/models/adminModelList';

/**
 * GET /api/admin/models?view=&search=&providers=&types=&sources=&showFoundationIds=&sort=&dir=&page=&pageSize=
 * -> AdminModelListResponse (@bike4mind/common). Spec: docs/admin-models-spec.md sections 4 and 7.1.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const query = parseAdminModelListQuery(req.query as Record<string, string | string[] | undefined>);
  return res.json(modelDiscoveryService.adminModelListPage(await loadAdminModelRows(), query));
});

export default handler;
