import { userApiKeyRepository } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { evaluateCounterLockout, resetApiKeyRateLimit, resolveCounterLimit } from '@server/utils/apiKeyRateLimitCheck';
import { UserApiKeyEvents } from '@bike4mind/common';
import { userApiKeyService } from '@bike4mind/services';

/**
 * POST /api/admin/user-api-keys/[id]/reset-rate-limit
 *
 * Admin-only: clear a key's minute and day rate-limit counters so the next
 * request opens a fresh window. Deliberately no ownership filter - support/ops
 * unblock any user's wedged key. [id] is the userApiKey document id.
 *
 * Also clears the management counter (see resetApiKeyRateLimit): this is the
 * only operator override for a client that has exhausted its own management
 * quota and locked itself out of the self-service rate-limit PATCH, its only
 * other path back.
 *
 * Response includes `lockout`: per-counter (request/management), per-window
 * (minute/day) whether usage was at/over its ceiling at the moment it was
 * reset - the only way to tell an admin which counter actually caused the
 * lockout, since the reset clears that state. Derived directly from what
 * `resetApiKeyRateLimit` atomically deleted (read and delete happen as one
 * operation per counter), never from a separate pre-read - a separate read
 * would leave a window for a concurrent request to move a counter between
 * "observed" and "cleared", misreporting the cause. A `lockout` entry is
 * omitted only if clearing that specific counter failed - best-effort, and
 * never blocks clearing (or reporting) the other counter.
 */
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query as { id?: string | string[] };
      if (typeof id !== 'string' || !id) {
        throw new BadRequestError('Invalid API key ID');
      }

      const apiKey = await userApiKeyRepository.findById(id);
      if (!apiKey) {
        throw new NotFoundError('API key not found');
      }

      const resetUsage = await resetApiKeyRateLimit(apiKey.id, { alsoResetManagement: true });
      const rateLimit = apiKey.rateLimit ?? userApiKeyService.API_KEY_RATE_LIMIT_DEFAULTS;
      const lockout = {
        request:
          resetUsage.request && evaluateCounterLockout(resetUsage.request, resolveCounterLimit('request', rateLimit)),
        management:
          resetUsage.management &&
          evaluateCounterLockout(resetUsage.management, resolveCounterLimit('management', rateLimit)),
      };

      // Attributed to the key owner; resetBy records the acting admin.
      // Best-effort: the reset already happened, and the counter write throws
      // for an orphaned key (owner doc deleted) - the exact case an admin
      // reset exists for. Mirrors the RATE_LIMITED path in apiKeyRateLimitCheck.
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
      ).catch(error => {
        req.logger.warn(`Failed to log rate-limit reset event for API key ${apiKey.id}: ${error}`);
      });

      req.logger.info(
        `Admin ${req.user.username} (${req.user.id}) reset rate-limit counters for API key ${apiKey.id} (owner ${apiKey.userId})`
      );

      return res.status(200).json({ success: true, id: apiKey.id, lockout });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
