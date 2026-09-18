import { userApiKeyRepository } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import {
  evaluateCounterLockout,
  getApiKeyRateLimitUsage,
  MANAGEMENT_RATE_LIMIT,
  resetApiKeyRateLimit,
} from '@server/utils/apiKeyRateLimitCheck';
import { UserApiKeyEvents } from '@bike4mind/common';

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
 * (minute/day) whether usage was at/over its ceiling just before this reset -
 * the only way to tell an admin which counter actually caused the lockout,
 * since the reset below clears that state. Best-effort: a counter's entry is
 * undefined if its usage read failed, but that never blocks the reset itself.
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

      // Read usage before the reset clears it - this is the only point at
      // which we can tell the admin which counter(s) actually caused the
      // lockout (request vs. management, minute vs. day). Best-effort: this
      // is a diagnostic on top of the reset, not a precondition for it, so a
      // read failure (e.g. a transient cache blip) must never stop the reset
      // itself - this route is the only operator override for a key locked
      // out of its own management quota.
      const [requestUsage, managementUsage] = await Promise.all([
        getApiKeyRateLimitUsage(apiKey.id).catch(error => {
          req.logger.warn(`Failed to read request rate-limit usage for API key ${apiKey.id}: ${error}`);
          return undefined;
        }),
        getApiKeyRateLimitUsage(apiKey.id, 'management').catch(error => {
          req.logger.warn(`Failed to read management rate-limit usage for API key ${apiKey.id}: ${error}`);
          return undefined;
        }),
      ]);
      const lockout = {
        request: requestUsage && evaluateCounterLockout(requestUsage, apiKey.rateLimit),
        management: managementUsage && evaluateCounterLockout(managementUsage, MANAGEMENT_RATE_LIMIT),
      };

      await resetApiKeyRateLimit(apiKey.id, { alsoResetManagement: true });

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
