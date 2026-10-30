import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { EmailEvents } from '@server/utils/eventBus';
import { buildEmailChangeMailer, type EmailChangeMessage } from '@server/users/emailChangeMailer';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { userService } from '@bike4mind/services';

interface RequestQuery {
  userId: string;
}

// Admin-only endpoint to resend email change verification for a specific user
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

      // Get the user
      const user = await userRepository.findById(userId);

      if (!user) {
        throw new BadRequestError('User not found');
      }

      // Check if user has pending email change
      if (!user.pendingEmail || !user.pendingEmailToken) {
        throw new BadRequestError('No pending email change found for this user');
      }

      // Auto-cancel if token is expired
      if (user.pendingEmailExpires && new Date(user.pendingEmailExpires) < new Date()) {
        // Store the email addresses before cancellation for logging
        const oldEmail = user.email;
        const expiredPendingEmail = user.pendingEmail;
        const expiredAt = new Date(user.pendingEmailExpires);

        // Cancel the email change
        await userService.cancelEmailChange({ userId: user.id }, { db: { users: userRepository } });

        // Log the auto-cancellation
        await recordAdminActionFromRequest(req, {
          action: 'user.email.change_cancelled',
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
          summary: 'cancelled expired email change',
          reason: `Token expired on ${expiredAt.toISOString()} - auto-cancelled by system when admin attempted resend`,
          details: { currentEmail: oldEmail, pendingEmail: expiredPendingEmail },
        });

        req.logger.info(
          `Admin ${req.user.username} (${req.user.id}) triggered auto-cancellation of expired email change for user ${user.username} (${userId}). Token expired: ${expiredAt.toISOString()}`
        );

        throw new BadRequestError(
          `Email change token expired on ${expiredAt.toLocaleString()} and has been automatically cancelled. ` +
            `The pending change from "${oldEmail}" to "${expiredPendingEmail}" has been cleared. ` +
            `The user will need to request a new email change through the normal flow.`
        );
      }

      // Resend the email change verification email
      const outbox: EmailChangeMessage[] = [];
      await buildEmailChangeMailer(outbox, { adminNote: 'resent' }).sendEmailChangeVerification(
        user,
        user.pendingEmail,
        user.pendingEmailToken
      );
      for (const email of outbox) {
        await EmailEvents.Send.publish(email);
      }

      // Update the resent timestamp
      await userRepository.update({ id: user.id, pendingEmailSentAt: new Date() });

      // Log admin action
      await recordAdminActionFromRequest(req, {
        action: 'user.email.change_resent',
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
        summary: 'resent email change verification',
        details: { currentEmail: user.email, pendingEmail: user.pendingEmail },
      });

      req.logger.info(
        `Admin ${req.user.username} (${req.user.id}) resent email change verification for user ${user.username} (${userId})`
      );

      return res.json({ message: 'Email change verification resent successfully' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
