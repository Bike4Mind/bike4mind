import { userApiKeyService } from '@bike4mind/services';
import { apiKeyUsageLogRepository, userApiKeyRepository } from '@bike4mind/database/auth';
import { userRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import {
  adminUserApiKeysResponseSchema,
  ApiKeyScope,
  type IUserApiKey,
  type IUserApiKeyDocument,
} from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { getApiKeyRateLimitUsage, type RateLimitUsage } from '@server/utils/apiKeyRateLimitCheck';
import { describeApiKeyAccess } from '@server/utils/apiKeyAccessGate';

// Hydrated docs only emit schema paths (and drop the key hashes) through toJSON.
function serializeKey(key: IUserApiKeyDocument): IUserApiKey {
  return (key as IUserApiKeyDocument & { toJSON: () => IUserApiKey }).toJSON();
}

/**
 * GET /api/admin/users/[userId]/user-api-keys
 *
 * Admin-only list of the API keys a user owns (docs whose userId is the
 * target user - this includes org-billed keys the user minted, but not org
 * keys minted by someone else). All statuses are returned so support can see
 * disabled and expired keys too.
 *
 * liveUsage carries each key's current rate-limit counters read from the
 * cache - the usage.* fields on the key doc itself are not maintained. A key
 * whose counter sits at its limit is wedged; the per-key reset endpoint
 * (/api/admin/user-api-keys/[id]/reset-rate-limit) clears it.
 *
 * requests is each key's request count over the last 24 hours and 7 days from the usage log (one
 * aggregation; a key with no requests is absent), and access explains whether the paid-subscription
 * switch lets this user mint and use personal keys.
 *
 * The secret fields are withheld by adminUserApiKeysResponseSchema and, as a second
 * layer, by UserApiKeyModel's toJSON transform, so the docs must stay hydrated - do not
 * switch this path to .lean().
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId } = req.query as { userId?: string | string[] };
    if (typeof userId !== 'string' || !userId) {
      throw new BadRequestError('Invalid user ID');
    }

    const targetUser = await userRepository.findById(userId);
    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    const apiKeys = await userApiKeyService.listUserApiKeys(
      userId,
      { db: { userApiKeys: userApiKeyRepository } },
      { includeDisabled: true }
    );

    const [usageEntries, requests, access] = await Promise.all([
      Promise.all(apiKeys.map(async key => [key.id, await getApiKeyRateLimitUsage(key.id)] as const)),
      apiKeyUsageLogRepository.countRequestsByKeyWindows(targetUser.id, new Date()),
      describeApiKeyAccess(targetUser),
    ]);
    const liveUsage: Record<string, RateLimitUsage> = Object.fromEntries(usageEntries);

    return respond(res, adminUserApiKeysResponseSchema, {
      apiKeys: apiKeys.map(serializeKey),
      liveUsage,
      requests,
      access,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
