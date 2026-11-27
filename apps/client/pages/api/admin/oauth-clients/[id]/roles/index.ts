import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { addOAuthClientRole, listOAuthClientRoles } from '@bike4mind/database';
import { oauthClientRoleSchema } from '@bike4mind/common';

/** GET lists the roles a client offers and who holds each; POST adds a role ({ key, label, reason }). */
const handler = adminApi({
  adminPermissions: { GET: ['support:read', 'settings:manage'], POST: 'settings:manage' },
  auth: 'jwtOnly',
})
  .get(async (req, res) => {
    const { id } = req.query;
    if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');
    res.status(200).json(await listOAuthClientRoles(id));
  })
  .post(async (req, res) => {
    const { id } = req.query;
    if (typeof id !== 'string' || !id) throw new BadRequestError('OAuth client id required');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parseOrBadRequest(oauthClientRoleSchema, { key: body.key, label: body.label });
    const reason = parseAdminActionReason(body.reason);

    const { client, role } = await addOAuthClientRole(id, input);

    await recordAdminActionFromRequest(req, {
      action: 'oauth_client.role_added',
      target: { kind: 'oauthClient', id: client.id, displayName: client.name },
      summary: `added the role ${role.key} to the OAuth client`,
      reason,
      details: { clientId: client.clientId, role: role.key, label: role.label },
    });

    res.status(201).json(client);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
