import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { updateOAuthClient } from '@bike4mind/database';
import { ApiKeyScope, updateOAuthClientSchema } from '@bike4mind/common';

const handler = adminApi({
  adminPermissions: { PATCH: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).patch(async (req, res) => {
  const { id } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');

  const input = parseOrBadRequest(updateOAuthClientSchema, req.body);
  const { before, after } = await updateOAuthClient(id, input);

  const action =
    input.isActive !== undefined && input.isActive !== before.isActive
      ? input.isActive
        ? ('oauth_client.activated' as const)
        : ('oauth_client.deactivated' as const)
      : ('oauth_client.updated' as const);

  await recordAdminActionFromRequest(req, {
    action,
    target: { kind: 'oauthClient', id: after.id, displayName: after.name },
    summary:
      action === 'oauth_client.updated' ? 'updated the OAuth client' : `${action.split('.')[1]} the OAuth client`,
    changes: [
      { field: 'redirectUris', before: before.redirectUris, after: after.redirectUris },
      { field: 'isActive', before: before.isActive, after: after.isActive },
    ],
    details: { clientId: after.clientId },
  });

  res.status(200).json(after);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
