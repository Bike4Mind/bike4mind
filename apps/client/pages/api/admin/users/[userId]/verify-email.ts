import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { AuthEvents } from '@bike4mind/common';
import { logAuditEvent, EmailAuditEvents } from '@server/utils/auditLog';

interface RequestQuery {
  userId: string;
}

// Admin-only endpoint to manually verify a user's email
const handler = baseApi({ auth: true })
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

      await withTransaction(async () => {
        // Get the user
        const user = await userRepository.findById(userId);

        if (!user) {
          throw new BadRequestError('User not found');
        }

        // Check if already verified
        if (user.emailVerified) {
          return res.json({ message: 'Email is already verified', alreadyVerified: true });
        }

        // Update user email verification status
        user.emailVerified = true;
        user.emailVerifiedAt = new Date();
        user.emailVerificationToken = null;
        user.emailVerificationExpires = null;
        user.emailVerificationSentAt = null;

        await userRepository.update(user);

        // Log admin action with audit trail
        await logAuditEvent(
          {
            userId: user.id,
            action: EmailAuditEvents.ADMIN_EMAIL_VERIFIED,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            adminUserId: req.user.id,
            adminUsername: req.user.username,
          },
          req.logger
        );

        // Log admin action to analytics
        await logEvent({
          userId: user.id,
          type: AuthEvents.EMAIL_VERIFIED,
          metadata: {},
        });

        req.logger.info(
          `Admin ${req.user.username} (${req.user.id}) manually verified email for user ${user.username} (${userId})`
        );

        return res.json({ message: 'Email verified successfully' });
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
