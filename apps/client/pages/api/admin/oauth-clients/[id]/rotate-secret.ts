import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { AdminConfigAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { rotateOAuthClientSecret } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const { id } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');

  const result = await rotateOAuthClientSecret(id);

  await logAuditEvent(
    {
      userId: req.user!.id,
      action: AdminConfigAuditEvents.OAUTH_CLIENT_SECRET_ROTATED,
      adminUserId: req.user!.id,
      adminUsername: req.user!.username,
      ip: req.ip,
      configType: 'oauth-client',
      metadata: { oauthClientId: result.client.id, clientId: result.client.clientId, name: result.client.name },
    },
    req.logger
  );

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
