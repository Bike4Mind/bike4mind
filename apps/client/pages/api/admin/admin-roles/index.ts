import { AdminRoleCreateSchema, ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { ADMIN_ROLES_RATE_LIMIT, adminRolesDeps } from '@server/admin/adminRoles/adapters';
import { createAdminRole, listAdminRoles } from '@server/admin/adminRoles/adminRoles';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';

/**
 * Every admin role with its member count (GET), or a new role (POST, full admins only:
 * settings:manage admits the request and createAdminRole refuses a delegate).
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit(ADMIN_ROLES_RATE_LIMIT))
  .use(csrfProtection())
  .get(
    asyncHandler(async (req, res) => {
      const roles = await listAdminRoles(adminRolesDeps(req));
      return res.json({ roles });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const input = parseOrBadRequest(AdminRoleCreateSchema, req.body);
      const role = await createAdminRole(req.user, input, adminRolesDeps(req));
      return res.status(201).json(role);
    })
  );

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '8kb' } } };
export default handler;
