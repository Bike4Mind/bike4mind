import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { removeOAuthClientRole } from '@bike4mind/database';

const MAX_AUDITED_USER_IDS = 100;

/** DELETE removes a role from the client and every assignment of it ({ reason }); a delegated admin cannot when a holder has admin access. */
const handler = adminApi({
  adminPermissions: { DELETE: 'settings:manage' },
  auth: 'jwtOnly',
}).delete(async (req, res) => {
  const { id, key } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');
  if (typeof key !== 'string' || !key) throw new BadRequestError('Role key required');
  const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

  const { client, role, removedAssignments, removedUserIds } = await removeOAuthClientRole(id, key, {
    actor: req.user,
  });

  await recordAdminActionFromRequest(req, {
    action: 'oauth_client.role_removed',
    target: { kind: 'oauthClient', id: client.id, displayName: client.name },
    summary: `removed the role ${role.key} from the OAuth client`,
    reason,
    details: {
      clientId: client.clientId,
      role: role.key,
      label: role.label,
      removedAssignments,
      removedUserIds: removedUserIds.slice(0, MAX_AUDITED_USER_IDS),
      ...(removedUserIds.length > MAX_AUDITED_USER_IDS ? { removedUserIdsTruncated: true } : {}),
    },
  });

  res.status(200).json(client);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
