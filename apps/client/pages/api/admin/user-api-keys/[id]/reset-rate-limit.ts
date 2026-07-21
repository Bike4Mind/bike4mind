import { userApiKeyRepository } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { resetApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { UserApiKeyEvents } from '@bike4mind/common';

/**
 * POST /api/admin/user-api-keys/[id]/reset-rate-limit
 *
 * Admin-only: clear a key's minute and day rate-limit counters so the next
 * request opens a fresh window. Deliberately no ownership filter - support/ops
 * unblock any user's wedged key. [id] is the userApiKey document id.
 */
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query;
      if (typeof id !== 'string' || !id) {
        throw new BadRequestError('Invalid API key ID');
      }

      const apiKey = await userApiKeyRepository.findById(id);
      if (!apiKey) {
        throw new NotFoundError('API key not found');
      }

      await resetApiKeyRateLimit(apiKey.id);

      // Attributed to the key owner; resetBy records the acting admin.
      await logEvent(
        {
          userId: apiKey.userId,
          type: UserApiKeyEvents.RATE_LIMIT_RESET,
          metadata: {
            keyId: apiKey.id,
            name: apiKey.name,
            resetBy: req.user.id,
          },
        },
        { ability: req.ability }
      );

      req.logger.info(
        `Admin ${req.user.username} (${req.user.id}) reset rate-limit counters for API key ${apiKey.id} (owner ${apiKey.userId})`
      );

      return res.status(200).json({ success: true, id: apiKey.id });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
