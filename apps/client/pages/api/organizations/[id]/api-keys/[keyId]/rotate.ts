// POST /api/organizations/:id/api-keys/:keyId/rotate
// Replaces an org-owned key's secret and returns the new one once. The key stays with the org's
// service account (rotateUserApiKey never re-owns an org-owned key). Owner, current manager or
// platform admin (verifyOrgAccess).

import { type IOrgApiKeySecretResponse } from '@bike4mind/common';
import { organizationRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadOrgOwnedKey, resolveCreatorNames, toOrgApiKeyView } from '@server/organizations/orgApiKeys';
import { assertApiKeyAccessAllowed } from '@server/utils/apiKeyAccessGate';
import { verifyOrgAccess } from '@server/utils/orgAccess';

const stringParam = (value: unknown): string => (typeof value === 'string' ? value : '');

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, IOrgApiKeySecretResponse, unknown, { id?: string; keyId?: string }>(async (req, res) => {
    const user = req.user!;
    const org = await verifyOrgAccess(user, stringParam(req.query.id));
    const { serviceAccount, apiKey } = await loadOrgOwnedKey(org.id, stringParam(req.query.keyId));

    // Rotation mints a fresh secret, so it is a mint for the admin paid-only switch.
    await assertApiKeyAccessAllowed(
      user,
      { billingOwnerType: apiKey.billingOwnerType, organizationId: apiKey.organizationId },
      req
    );

    const rotated = await userApiKeyService.rotateUserApiKey(
      serviceAccount.id,
      { keyId: apiKey.id },
      {
        db: {
          userApiKeys: userApiKeyRepository,
          organizations: organizationRepository,
          realtimeConnections: realtimeConnectionRepository,
        },
      }
    );

    await recordAdminActionFromRequest(req, {
      action: 'org.api_key.rotated',
      actorScope: 'organization',
      target: { kind: 'organization', id: org.id, displayName: org.name },
      summary: `rotated organization API key "${rotated.name}"`,
      details: { keyId: rotated.id, keyPrefix: rotated.keyPrefix },
    });

    const current = await userApiKeyRepository.findByUserIdAndId(serviceAccount.id, apiKey.id);
    if (!current) throw new Error('Rotated organization API key could not be read back');
    const creatorNames = await resolveCreatorNames([current]);
    return res.status(200).json({ apiKey: toOrgApiKeyView(current, creatorNames), key: rotated.key });
  })
);

export default handler;
