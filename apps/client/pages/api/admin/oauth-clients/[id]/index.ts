import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, parseOrBadRequest } from '@server/utils/errors';
import { AdminConfigAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { updateOAuthClient } from '@bike4mind/database';
import { ApiKeyScope, updateOAuthClientSchema } from '@bike4mind/common';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).patch(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const { id } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');

  const input = parseOrBadRequest(updateOAuthClientSchema, req.body);
  const { before, after } = await updateOAuthClient(id, input);

  const action =
    input.isActive !== undefined && input.isActive !== before.isActive
      ? input.isActive
        ? AdminConfigAuditEvents.OAUTH_CLIENT_ACTIVATED
        : AdminConfigAuditEvents.OAUTH_CLIENT_DEACTIVATED
      : AdminConfigAuditEvents.OAUTH_CLIENT_UPDATED;

  await logAuditEvent(
    {
      userId: req.user!.id,
      action,
      adminUserId: req.user!.id,
      adminUsername: req.user!.username,
      ip: req.ip,
      configType: 'oauth-client',
      oldConfig: { redirectUris: before.redirectUris, isActive: before.isActive },
      newConfig: { redirectUris: after.redirectUris, isActive: after.isActive },
      metadata: { oauthClientId: after.id, clientId: after.clientId, name: after.name },
    },
    req.logger
  );

  res.status(200).json(after);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
