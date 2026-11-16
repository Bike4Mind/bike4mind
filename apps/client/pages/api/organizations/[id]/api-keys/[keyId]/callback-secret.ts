// POST /api/organizations/:id/api-keys/:keyId/callback-secret
// Mints or replaces an org-owned key's generation-callback signing secret and returns the plaintext
// once. Owner, current manager or platform admin (verifyOrgAccess); browser session only.

import { ApiKeyStatus } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadOrgOwnedKey } from '@server/organizations/orgApiKeys';
import { verifyOrgAccess } from '@server/utils/orgAccess';

const stringParam = (value: unknown): string => (typeof value === 'string' ? value : '');

function assertNotRevoked(key: { status: ApiKeyStatus }): void {
  if (key.status === ApiKeyStatus.DISABLED) {
    throw new BadRequestError('A revoked key cannot get a callback signing secret');
  }
}

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string; keyId?: string }>(async (req, res) => {
    const org = await verifyOrgAccess(req.user!, stringParam(req.query.id));
    const { serviceAccount, apiKey } = await loadOrgOwnedKey(org.id, stringParam(req.query.keyId));
    assertNotRevoked(apiKey);

    // The secret and its strict audit row commit together. A retried transaction mints a new secret,
    // and the response carries the one that committed.
    const rotated = await withTransaction(async () => {
      assertNotRevoked((await loadOrgOwnedKey(org.id, apiKey.id)).apiKey);
      const result = await userApiKeyService.rotateCallbackSigningSecret(
        serviceAccount.id,
        { keyId: apiKey.id },
        { db: { userApiKeys: userApiKeyRepository } }
      );
      await recordAdminActionFromRequest(req, {
        action: 'org.api_key.callback_secret_rotated',
        actorScope: 'organization',
        target: { kind: 'organization', id: org.id, displayName: org.name },
        summary: `replaced the callback signing secret of organization API key "${result.name}"`,
        details: { keyId: apiKey.id, keyPrefix: apiKey.keyPrefix },
      });
      return result;
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(rotated);
  })
);

export default handler;
