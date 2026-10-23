import { z } from 'zod';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { ApiKeyScope } from '@bike4mind/common';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

interface RequestQuery {
  userId: string;
}

const bodySchema = z.object({ approved: z.boolean() });

// Admin-only endpoint to trust (or stop trusting) an account for minting personal API keys
// without waiting for the account-age or purchase requirement. Email must still be verified.
const handler = baseApi({ auth: true, requiredScopes: [ApiKeyScope.ADMIN] })
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

      const parsedBody = bodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new BadRequestError('Invalid request body: expected { approved: boolean }');
      }
      const { approved } = parsedBody.data;

      await withTransaction(async () => {
        const user = await userRepository.findById(userId);

        if (!user) {
          throw new BadRequestError('User not found');
        }

        const before = user.apiKeyTrustApproved === true;
        // Unchanged is a no-op: no write and no audit entry, like verify-email on an already-verified user.
        if (before === approved) return;

        await userRepository.update({ id: user.id, apiKeyTrustApproved: approved });

        await recordAdminActionFromRequest(req, {
          action: approved ? 'user.api_key_trust.approved' : 'user.api_key_trust.revoked',
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
          summary: approved ? 'approved account for personal API keys' : 'revoked personal API key trust',
          changes: [{ field: 'apiKeyTrustApproved', before, after: approved }],
        });

        req.logger.info(
          `Admin ${req.user.username} (${req.user.id}) set apiKeyTrustApproved=${approved} for user ${user.username} (${userId})`
        );
      });

      return res.json({ apiKeyTrustApproved: approved });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
