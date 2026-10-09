import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, parseOrBadRequest } from '@server/utils/errors';
import { AdminConfigAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { createOAuthClient, listOAuthClients } from '@bike4mind/database';
import { ApiKeyScope, createOAuthClientSchema } from '@bike4mind/common';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    res.status(200).json(await listOAuthClients());
  })
  .post(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const input = parseOrBadRequest(createOAuthClientSchema, req.body);
    const result = await createOAuthClient(input);

    await logAuditEvent(
      {
        userId: req.user!.id,
        action: AdminConfigAuditEvents.OAUTH_CLIENT_CREATED,
        adminUserId: req.user!.id,
        adminUsername: req.user!.username,
        ip: req.ip,
        configType: 'oauth-client',
        metadata: {
          oauthClientId: result.client.id,
          clientId: result.client.clientId,
          name: result.client.name,
          clientType: result.client.clientType,
          redirectUris: result.client.redirectUris,
          federated: !!result.client.federatedIdp,
        },
      },
      req.logger
    );

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
