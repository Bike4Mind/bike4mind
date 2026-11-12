import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { organizationRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { logEventSafe } from '@bike4mind/server-utils/utils/analyticsLog';
import { ApiKeyScope, UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isApiKeyScopeOffered } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { resolveApiKeyScopeAccess } from '@server/entitlements/apiKeyScopeAccess';
import { requireStepUp } from '@server/auth/stepUp';
import { notifyApiKeyRotationReown } from '@server/utils/apiKeyRotationNotifier';
import { assertApiKeyAccessAllowed } from '@bike4mind/server-utils/utils/apiKeyAccessGate';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const keyId = req.query.id;

    if (!keyId) throw new BadRequestError('Invalid key ID');

    // Rotation mints a fresh secret, so it is a mint for the admin paid-only switch.
    const apiKey = await userApiKeyService.resolveOwnedApiKey(userId, keyId, {
      db: { userApiKeys: userApiKeyRepository, organizations: organizationRepository },
    });
    if (!apiKey) throw new NotFoundError('API key not found');
    // Rotating hands back a fresh secret, and an org admin's rotation re-owns the key, so a
    // persona-mint key is held to the same bar as minting one.
    if (apiKey.scopes?.includes(ApiKeyScope.PERSONAS_MINT)) {
      if (!isApiKeyScopeOffered(ApiKeyScope.PERSONAS_MINT, await resolveApiKeyScopeAccess(req))) {
        throw new ForbiddenError('Only admins and developers can rotate a persona-mint key');
      }
      await requireStepUp(req);
    }
    await assertApiKeyAccessAllowed(
      req.user,
      {
        billingOwnerType: apiKey.billingOwnerType,
        organizationId: apiKey.organizationId,
        createdByUserId: apiKey.metadata?.createdByUserId,
      },
      req
    );

    const rotatedKey = await userApiKeyService.rotateUserApiKey(
      userId,
      { keyId },
      {
        db: {
          userApiKeys: userApiKeyRepository,
          organizations: organizationRepository,
          realtimeConnections: realtimeConnectionRepository,
        },
        // Undefined for a browser/JWT caller (unrestricted: they hold the whole
        // account); the actual held scopes when an API key is rotating, which is when
        // the no-escalation rule applies. `?? []` on purpose: an api key whose scopes
        // are absent holds NO scope and must deny, never fall through to the
        // browser-caller (undefined) branch. See rotateUserApiKey's escalation guard.
        callerScopes: req.apiKeyInfo ? (req.apiKeyInfo.scopes ?? []) : undefined,
      }
    );

    await logEventSafe(
      {
        userId,
        type: UserApiKeyEvents.ROTATED,
        metadata: {
          keyId,
          name: rotatedKey.name,
          // Present only when an org admin rotated someone else's key: the rotation
          // re-owned it, so this is the audit trail for the change of hands.
          ...(rotatedKey.previousOwnerUserId ? { previousOwnerUserId: rotatedKey.previousOwnerUserId } : {}),
        },
      },
      { ability: req.ability },
      req.logger
    );

    if (rotatedKey.previousOwnerUserId) {
      const REOWN_NOTIFY_TIMEOUT_MS = 5_000;
      let timeoutId: NodeJS.Timeout;
      const timeoutP = new Promise<void>(resolve => {
        timeoutId = setTimeout(() => {
          req.logger.warn('[userApiKey] re-own notification timed out; credential returned without send confirmation', {
            previousOwnerUserId: rotatedKey.previousOwnerUserId,
          });
          resolve();
        }, REOWN_NOTIFY_TIMEOUT_MS);
      });
      await Promise.race([
        notifyApiKeyRotationReown(rotatedKey.previousOwnerUserId, rotatedKey.name, req.logger).finally(() =>
          clearTimeout(timeoutId)
        ),
        timeoutP,
      ]);
    }

    return res.status(200).json(rotatedKey);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
