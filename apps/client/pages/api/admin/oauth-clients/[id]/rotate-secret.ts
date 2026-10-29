import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { rotateOAuthClientSecret } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const { id } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');

  const result = await rotateOAuthClientSecret(id);

  await recordAdminActionFromRequest(req, {
    action: 'oauth_client.secret_rotated',
    target: { kind: 'oauthClient', id: result.client.id, displayName: result.client.name },
    summary: 'rotated the client secret',
    details: { clientId: result.client.clientId },
  });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
