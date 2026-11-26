import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { removeOAuthClientRole } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';

/** DELETE removes a role from the client and every assignment of it ({ reason }). */
const handler = adminApi({
  adminPermissions: { DELETE: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).delete(async (req, res) => {
  const { id, key } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');
  if (typeof key !== 'string' || !key) throw new BadRequestError('Role key required');
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

  const { client, role, removedAssignments } = await removeOAuthClientRole(id, key);

  await recordAdminActionFromRequest(req, {
    action: 'oauth_client.role_removed',
    target: { kind: 'oauthClient', id: client.id, displayName: client.name },
    summary: `removed the role ${role.key} from the OAuth client`,
    reason,
    details: { clientId: client.clientId, role: role.key, label: role.label, removedAssignments },
  });

  res.status(200).json(client);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
