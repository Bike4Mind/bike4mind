import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository } from '@bike4mind/database';
import { ApiKeyScope, ConflictError, assertCanActOnAdminTarget } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { BadRequestError, hashEmailToken } from '@bike4mind/utils';
import { randomUUID } from 'crypto';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import { buildEmailChangeMailer, type EmailChangeMessage } from '@server/users/emailChangeMailer';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { userService } from '@bike4mind/services';

interface RequestQuery {
  userId: string;
}

// Admin-only endpoint to resend email change verification for a specific user
const handler = adminApi({
  auth: true,
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      const { userId } = req.query as RequestQuery;

      if (typeof userId !== 'string' || !userId) {
        throw new BadRequestError('Invalid user ID');
      }

      // Get the user
      const user = await userRepository.findById(userId);

      if (!user) {
        throw new BadRequestError('User not found');
      }
      assertCanActOnAdminTarget(req.user, user, 'resend an email change to');

      // Check if user has pending email change
      if (!user.pendingEmail || !user.pendingEmailToken) {
        throw new BadRequestError('No pending email change found for this user');
      }

      const now = new Date();
      const expiresAt = user.pendingEmailExpires
        ? new Date(user.pendingEmailExpires)
        : user.pendingEmailSentAt
          ? new Date(new Date(user.pendingEmailSentAt).getTime() + userService.EMAIL_VERIFICATION_TOKEN_EXPIRY)
          : null;
      if (!expiresAt) throw new BadRequestError('Pending email change has no issue date');

      // Auto-cancel if token is expired.
      if (expiresAt <= now) {
        // Store the email addresses before cancellation for logging
        const oldEmail = user.email;
        const expiredPendingEmail = user.pendingEmail;
        const expiredAt = expiresAt;

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

      // Only a hash of the token is stored, so a resend issues a fresh token (keeping the original
      // expiry); the link in any earlier email stops working.
      const token = randomUUID();
      const rotated = await userRepository.rotatePendingEmailToken(user, hashEmailToken(token), expiresAt, now);
      if (!rotated) throw new ConflictError('The pending email change was updated. Reload before resending.');

      const outbox: EmailChangeMessage[] = [];
      await buildEmailChangeMailer(outbox, { adminNote: 'resent' }).sendEmailChangeVerification(
        user,
        user.pendingEmail,
        token
      );
      for (const email of outbox) {
        await EmailEvents.Send.publish(email);
      }

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
