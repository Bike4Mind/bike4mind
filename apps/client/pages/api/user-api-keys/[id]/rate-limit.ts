import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { BadRequestError } from '@server/utils/errors';

interface UpdateRateLimitRequest {
  requestsPerMinute?: number;
  requestsPerDay?: number;
}

/**
 * PATCH /api/user-api-keys/[id]/rate-limit
 *
 * Change a key's request ceilings in place, so raising or lowering a limit no
 * longer means revoking and re-minting. Only the fields sent change.
 *
 * Not admin-gated: ownership-scoped self-service, same posture as the sibling
 * embed-config PATCH. `updateApiKeyRateLimit` resolves the key via
 * findByUserIdAndId, so a caller can only ever retarget their own key. Bounds
 * are the service's (shared with mint); out-of-range values come back 422.
 *
 * csrfProtection is defense in depth rather than a live hole - a cross-site
 * PATCH carrying JSON cannot get past preflight anyway - but it costs the
 * browser client nothing, since the check reads Sec-Fetch and Origin headers
 * and exchanges no token.
 */
const handler = baseApi()
  .use(csrfProtection())
  .patch(
    asyncHandler<{}, unknown, UpdateRateLimitRequest, { id: string }>(async (req, res) => {
      const userId = req.user?.id;
      const keyId = req.query.id;
      const { requestsPerMinute, requestsPerDay } = req.body;

      if (!keyId) throw new BadRequestError('Invalid key ID');

      const updated = await userApiKeyService.updateApiKeyRateLimit(
        userId,
        { keyId, requestsPerMinute, requestsPerDay },
        { db: { userApiKeys: userApiKeyRepository } }
      );

      await logEvent(
        {
          userId,
          type: UserApiKeyEvents.UPDATED,
          metadata: {
            keyId,
            name: updated.name,
            updatedFields: [
              ...(requestsPerMinute !== undefined ? ['rateLimit.requestsPerMinute'] : []),
              ...(requestsPerDay !== undefined ? ['rateLimit.requestsPerDay'] : []),
            ],
          },
        },
        { ability: req.ability }
      );

      return res.status(200).json(updated);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
