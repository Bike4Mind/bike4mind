import { adminApi } from '@server/middlewares/adminApi';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { createOAuthClient, listOAuthClients } from '@bike4mind/database';
import { ApiKeyScope, createOAuthClientSchema } from '@bike4mind/common';

const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req, res) => {
    res.status(200).json(await listOAuthClients());
  })
  .post(async (req, res) => {
    const input = parseOrBadRequest(createOAuthClientSchema, req.body);
    const result = await createOAuthClient(input);

    await recordAdminActionFromRequest(req, {
      action: 'oauth_client.created',
      target: { kind: 'oauthClient', id: result.client.id, displayName: result.client.name },
      summary: 'created an OAuth client',
      details: {
        clientId: result.client.clientId,
        clientType: result.client.clientType,
        redirectUris: result.client.redirectUris,
        federated: !!result.client.federatedIdp,
      },
    });

    // Carries the plaintext secret (as does rotate); it is never stored or logged.
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
