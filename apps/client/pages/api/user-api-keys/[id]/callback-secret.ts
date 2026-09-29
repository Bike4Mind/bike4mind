import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { organizationRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { logEventSafe } from '@server/utils/analyticsLog';
import { ApiKeyScope, UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';

/**
 * Mint or replace the key's generation-callback signing secret. The plaintext is in this
 * response only. Authorized exactly like rotate.ts (see rotateCallbackSigningSecret). An API
 * key needs ai:generate, the scope every callbackUrl request already carries.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const keyId = req.query.id;

    if (!keyId) throw new BadRequestError('Invalid key ID');

    const rotated = await userApiKeyService.rotateCallbackSigningSecret(
      userId,
      { keyId },
      {
        db: {
          userApiKeys: userApiKeyRepository,
          organizations: organizationRepository,
        },
        // `?? []` on purpose, as in rotate.ts: an API key with absent scopes must deny.
        callerScopes: req.apiKeyInfo ? (req.apiKeyInfo.scopes ?? []) : undefined,
      }
    );

    await logEventSafe(
      {
        userId,
        type: UserApiKeyEvents.UPDATED,
        metadata: { keyId, name: rotated.name, updatedFields: ['callbackSigningSecret'] },
      },
      { ability: req.ability },
      req.logger
    );

    return res.status(200).json(rotated);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
