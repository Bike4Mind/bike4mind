import { AdminRoleUpdateSchema, ApiKeyScope, NotFoundError } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { toObjectIdString } from '@bike4mind/server-utils/utils/objectId';
import { ADMIN_ROLES_RATE_LIMIT, adminRolesDeps } from '@server/admin/adminRoles/adapters';
import { deleteAdminRole, getAdminRole, updateAdminRole } from '@server/admin/adminRoles/adminRoles';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';

const roleIdOf = (query: unknown): string => {
  const id = typeof query === 'object' && query !== null ? (query as { id?: unknown }).id : undefined;
  const roleId = typeof id === 'string' ? toObjectIdString(id) : undefined;
  if (!roleId) throw new NotFoundError('Admin role not found');
  return roleId;
};

/**
 * One admin role: read (GET), edit (PATCH) or delete (DELETE). Writes are full-admin only;
 * settings:manage admits the request and the service refuses a delegate.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read', PATCH: 'settings:manage', DELETE: 'settings:manage' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit(ADMIN_ROLES_RATE_LIMIT))
  .use(csrfProtection())
  .get(
    asyncHandler(async (req, res) => {
      return res.json(await getAdminRole(roleIdOf(req.query), adminRolesDeps(req)));
    })
  )
  .patch(
    asyncHandler(async (req, res) => {
      const roleId = roleIdOf(req.query);
      const patch = parseOrBadRequest(AdminRoleUpdateSchema, req.body);
      return res.json(await updateAdminRole(req.user, roleId, patch, adminRolesDeps(req)));
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      await deleteAdminRole(req.user, roleIdOf(req.query), adminRolesDeps(req));
      return res.status(204).end();
    })
  );

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '8kb' } } };
export default handler;
