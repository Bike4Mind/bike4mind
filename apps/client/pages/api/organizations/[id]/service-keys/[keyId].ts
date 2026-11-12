import { baseApi } from '@server/middlewares/baseApi';
import { resolveServiceKey } from '@server/organizations/serviceAccounts';
import { userApiKeyRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import { withTransaction } from '@bike4mind/db-core';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
import { assertApiKeyAccessAllowed } from '@bike4mind/server-utils/utils/apiKeyAccessGate';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';

const params = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i), keyId: z.string().regex(/^[a-f\d]{24}$/i) });
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['POST', 'DELETE'] })
  .post(async (req, res) => {
    const { id, keyId } = params.parse(req.query);
    const key = await resolveServiceKey(req.user, id, keyId);
    if (key.status !== 'active') throw new BadRequestError('Only active keys can be rotated');
    await assertApiKeyAccessAllowed(req.user, key);
    const result = await withTransaction(async () => {
      const rotated = await userApiKeyService.rotateUserApiKey(
        req.user.id,
        { keyId },
        {
          serviceAccountManagement: true,
          db: {
            userApiKeys: userApiKeyRepository,
            organizations: { findIdsAdministeredBy: async () => [id] },
            realtimeConnections: realtimeConnectionRepository,
          },
        }
      );
      await recordOrganizationAuditEvent({
        organizationId: id,
        actorUserId: req.user.id,
        action: 'api_key.rotated',
        targetId: keyId,
      });
      return rotated;
    });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(result);
  })
  .delete(async (req, res) => {
    const { id, keyId } = params.parse(req.query);
    await resolveServiceKey(req.user, id, keyId);
    await withTransaction(async () => {
      const changed = await userApiKeyRepository.revokeIfNotDisabled(keyId, req.user.id);
      if (changed)
        await recordOrganizationAuditEvent({
          organizationId: id,
          actorUserId: req.user.id,
          action: 'api_key.revoked',
          targetId: keyId,
        });
      await realtimeConnectionRepository.endConnections({ apiKeyId: keyId });
    });
    return res.json({ success: true });
  });

export const config = { api: { externalResolver: true } };
export default handler;
