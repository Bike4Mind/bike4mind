import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';

interface RequestQuery {
  userId: string;
}

interface CreateApiKeyBody {
  name: string;
  scopes: string[];
  expiresAt?: string;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
}

/**
 * POST /api/admin/users/[userId]/generate-api-key
 *
 * Admin-only endpoint to generate an API key on behalf of any user.
 * Useful for creating service account keys without logging in as the target user.
 */
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { userId } = req.query as RequestQuery;

      if (typeof userId !== 'string' || !userId) {
        throw new BadRequestError('Invalid user ID');
      }

      const targetUser = await userRepository.findById(userId);
      if (!targetUser) {
        throw new BadRequestError('User not found');
      }

      const { name, scopes, expiresAt, rateLimit } = req.body as CreateApiKeyBody;

      const newApiKey = await userApiKeyService.createUserApiKey(
        userId,
        {
          name,
          scopes: scopes as Parameters<typeof userApiKeyService.createUserApiKey>[1]['scopes'],
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          rateLimit,
          metadata: {
            clientIP: req.ip,
            userAgent: req.headers['user-agent'],
            createdFrom: 'dashboard' as const,
          },
        },
        {
          db: {
            userApiKeys: userApiKeyRepository,
          },
        }
      );

      // Log analytics event attributed to the target user
      await logEvent(
        {
          userId,
          type: UserApiKeyEvents.CREATED,
          metadata: {
            keyId: newApiKey.id,
            name: newApiKey.name,
            scopes: newApiKey.scopes,
            expiresAt: newApiKey.expiresAt?.toISOString(),
            createdFrom: 'dashboard',
          },
        },
        { ability: req.ability }
      );

      // Audit trail with admin details
      req.logger.info(
        `Admin ${req.user.username} (${req.user.id}) generated API key "${name}" for user ${targetUser.username} (${userId})`
      );

      return res.status(201).json(newApiKey);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
