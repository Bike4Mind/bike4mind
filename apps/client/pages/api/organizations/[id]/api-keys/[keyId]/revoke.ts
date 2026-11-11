// POST /api/organizations/:id/api-keys/:keyId/revoke
// Disables an org-owned key; it is refused from then on. Owner, current manager or platform admin
// (verifyOrgAccess). `revokedBy` records the admin, not the service account holding the key.

import { organizationRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadOrgOwnedKey } from '@server/organizations/orgApiKeys';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { z } from 'zod';

const RevokeOrgApiKeyBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).optional();

const stringParam = (value: unknown): string => (typeof value === 'string' ? value : '');

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, { success: true }, unknown, { id?: string; keyId?: string }>(async (req, res) => {
    const user = req.user!;
    const org = await verifyOrgAccess(user, stringParam(req.query.id));
    const reason = parseOrBadRequest(RevokeOrgApiKeyBodySchema, req.body)?.reason;
    const { serviceAccount, apiKey } = await loadOrgOwnedKey(org.id, stringParam(req.query.keyId));

    await userApiKeyService.revokeUserApiKey(
      serviceAccount.id,
      { keyId: apiKey.id, reason },
      {
        db: {
          userApiKeys: userApiKeyRepository,
          organizations: organizationRepository,
          realtimeConnections: realtimeConnectionRepository,
        },
        revokedBy: user.id,
      }
    );

    await recordAdminActionFromRequest(req, {
      action: 'org.api_key.revoked',
      actorScope: 'organization',
      target: { kind: 'organization', id: org.id, displayName: org.name },
      summary: `revoked organization API key "${apiKey.name}"`,
      details: { keyId: apiKey.id, keyPrefix: apiKey.keyPrefix, ...(reason ? { reason } : {}) },
    });

    return res.status(200).json({ success: true });
  })
);

export default handler;
