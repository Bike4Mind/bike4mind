import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { ApiKeyScope, AuthEvents } from '@bike4mind/common';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { applyEmailVerifiedGrants } from '@server/auth/emailVerifiedGrants';

interface RequestQuery {
  userId: string;
}

// Admin-only endpoint to manually verify a user's email
const handler = baseApi({ auth: true, requiredScopes: [ApiKeyScope.ADMIN] })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      // Check admin authorization
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { userId } = req.query as RequestQuery;

      if (typeof userId !== 'string' || !userId) {
        throw new BadRequestError('Invalid user ID');
      }

      const verifiedUser = await withTransaction(async () => {
        // Get the user
        const user = await userRepository.findById(userId);

        if (!user) {
          throw new BadRequestError('User not found');
        }

        // Check if already verified
        if (user.emailVerified) return null;

        // Update user email verification status
        await userRepository.update({
          id: user.id,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          emailVerificationToken: null,
          emailVerificationExpires: null,
          emailVerificationSentAt: null,
        });

        // Log admin action with audit trail
        await recordAdminActionFromRequest(req, {
          action: 'user.email.verified',
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
          summary: 'verified email',
        });

        // Log admin action to analytics
        await logEvent({
          userId: user.id,
          type: AuthEvents.EMAIL_VERIFIED,
          metadata: {},
        });

        req.logger.info(
          `Admin ${req.user.username} (${req.user.id}) manually verified email for user ${user.username} (${userId})`
        );
        return user;
      });

      if (!verifiedUser) {
        return res.json({ message: 'Email is already verified', alreadyVerified: true });
      }

      // After the commit, not inside it: partner membership re-reads the persisted emailVerified.
      // The account never reaches /api/email/verify now, so this is its one chance at those grants.
      if (verifiedUser.email) {
        await applyEmailVerifiedGrants({
          user: verifiedUser,
          verifiedEmail: verifiedUser.email,
          trigger: 'admin-verification',
          releaseReason: 'admin verified email',
          logger: req.logger,
        });
      }

      return res.json({ message: 'Email verified successfully' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
