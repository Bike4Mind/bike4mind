// POST /api/organizations/:id/api-keys/:keyId/rotate
// Replaces an active org-owned key's secret and returns the new one once. The key stays with the org's
// service account (rotateUserApiKey never re-owns an org-owned key). Owner, current manager or
// platform admin (verifyOrgAccess).

import { type IOrgApiKeySecretResponse } from '@bike4mind/common';
import { organizationRepository, withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  assertOrgApiKeyLive,
  loadOrgOwnedKey,
  resolveCreatorNames,
  toOrgApiKeyView,
} from '@server/organizations/orgApiKeys';
import { endKeyRealtimeConnections } from '@server/utils/adminApiKeyActions';
import { assertApiKeyAccessAllowed } from '@bike4mind/server-utils/utils/apiKeyAccessGate';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';

const stringParam = (value: unknown): string => (typeof value === 'string' ? value : '');

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string; keyId?: string }>(async (req, res) => {
    const user = req.user!;
    const org = await verifyOrgAccess(user, stringParam(req.query.id));
    const { serviceAccount, apiKey } = await loadOrgOwnedKey(org.id, stringParam(req.query.keyId));
    assertOrgApiKeyLive(apiKey, 'rotated');

    // Rotation mints a fresh secret, so it is a mint for the admin paid-only switch.
    await assertApiKeyAccessAllowed(
      user,
      { billingOwnerType: apiKey.billingOwnerType, organizationId: apiKey.organizationId },
      req
    );

    // The new secret and its strict audit row commit together: a failed audit leaves the old secret working.
    const rotated = await withTransaction(async () => {
      // Re-read under the transaction so a revoke that committed since the check above is refused.
      assertOrgApiKeyLive((await loadOrgOwnedKey(org.id, apiKey.id)).apiKey, 'rotated');
      const result = await userApiKeyService.rotateUserApiKey(
        serviceAccount.id,
        { keyId: apiKey.id },
        { db: { userApiKeys: userApiKeyRepository, organizations: organizationRepository }, includeOrgOwned: true }
      );
      await recordAdminActionFromRequest(req, {
        action: 'org.api_key.rotated',
        actorScope: 'organization',
        target: { kind: 'organization', id: org.id, displayName: org.name },
        summary: `rotated organization API key "${result.name}"`,
        details: { keyId: result.id, keyPrefix: result.keyPrefix },
      });
      return result;
    });
    // After commit, so an aborted rotation leaves the sockets of the still-valid old secret alone.
    await endKeyRealtimeConnections(rotated.id, req.logger);

    const current = await userApiKeyRepository.findByUserIdAndId(serviceAccount.id, apiKey.id);
    if (!current) throw new Error('Rotated organization API key could not be read back');
    const creatorNames = await resolveCreatorNames([current]);
    return res
      .status(200)
      .json({ apiKey: toOrgApiKeyView(current, creatorNames), key: rotated.key } satisfies IOrgApiKeySecretResponse);
  })
);

export default handler;
