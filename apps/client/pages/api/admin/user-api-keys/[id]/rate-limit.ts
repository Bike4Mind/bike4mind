import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';

/**
 * PATCH /api/admin/user-api-keys/[id]/rate-limit
 *
 * Admin-only: change any user's key ceilings without rotating the key. [id] is
 * the userApiKey document id. The owner is resolved here and the update runs
 * through the same ownership-scoped service as the self-service route, so both
 * paths share one set of bounds. Sits beside the counter-reset lever - lowering
 * a ceiling below a live counter wedges the key until the window rolls over, or
 * until reset-rate-limit clears it.
 */
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .patch(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query as { id?: string | string[] };
      if (typeof id !== 'string' || !id) {
        throw new BadRequestError('Invalid API key ID');
      }

      const { requestsPerMinute, requestsPerDay } = (req.body ?? {}) as {
        requestsPerMinute?: number;
        requestsPerDay?: number;
      };

      const apiKey = await userApiKeyRepository.findById(id);
      if (!apiKey) {
        throw new NotFoundError('API key not found');
      }

      const updated = await userApiKeyService.updateApiKeyRateLimit(
        apiKey.userId,
        { keyId: apiKey.id, requestsPerMinute, requestsPerDay },
        { db: { userApiKeys: userApiKeyRepository } }
      );

      // Attributed to the key owner. Best-effort for the same reason as the
      // reset route: the write already landed, and an orphaned key (owner doc
      // deleted) is exactly the case an admin edit exists for.
      await logEvent(
        {
          userId: apiKey.userId,
          type: UserApiKeyEvents.UPDATED,
          metadata: {
            keyId: apiKey.id,
            name: updated.name,
            updatedFields: [
              ...(requestsPerMinute !== undefined ? ['rateLimit.requestsPerMinute'] : []),
              ...(requestsPerDay !== undefined ? ['rateLimit.requestsPerDay'] : []),
            ],
          },
        },
        { ability: req.ability }
      ).catch(error => {
        req.logger.warn(`Failed to log rate-limit update event for API key ${apiKey.id}: ${error}`);
      });

      req.logger.info(
        `Admin ${req.user.username} (${req.user.id}) set rate limits ${updated.rateLimit.requestsPerMinute}/min, ` +
          `${updated.rateLimit.requestsPerDay}/day for API key ${apiKey.id} (owner ${apiKey.userId})`
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
