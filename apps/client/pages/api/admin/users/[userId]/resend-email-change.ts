import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { EmailEvents } from '@server/utils/eventBus';
import { generateVerificationLink, getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { logAuditEvent, EmailAuditEvents } from '@server/utils/auditLog';
import { userService } from '@bike4mind/services';

interface RequestQuery {
  userId: string;
}

// Admin-only endpoint to resend email change verification for a specific user
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
        await logAuditEvent(
          {
            userId: user.id,
            action: EmailAuditEvents.EMAIL_CHANGE_CANCELLED,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            adminUserId: req.user.id,
            adminUsername: req.user.username,
            oldEmail: oldEmail || undefined,
            newEmail: expiredPendingEmail || undefined,
            reason: `Token expired on ${expiredAt.toISOString()} - auto-cancelled by system when admin attempted resend`,
          },
          req.logger
        );

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
      const brand = process.env.APP_NAME || '';
      const logoUrl = getLogoUrl();
      const verificationLink = `${generateVerificationLink(user.pendingEmailToken).replace('/verify-email', '/verify-change')}`;

      const emailBody = `
      <!DOCTYPE html>
        <html>
          <head>
            <style>
              body {
                font-family: Arial, sans-serif;
                line-height: 1.5;
                color: #333333;
              }
              .content {
                margin: 20px;
              }
              .logo {
                display: block;
                margin-bottom: 20px;
              }
              a {
                color: #1a82e2;
              }
              .button {
                display: inline-block;
                padding: 12px 24px;
                background-color: #1a82e2;
                color: #ffffff;
                text-decoration: none;
                border-radius: 4px;
                margin: 20px 0;
              }
              .admin-note {
                background-color: #e3f2fd;
                border-left: 4px solid #2196f3;
                padding: 12px;
                margin: 20px 0;
              }
            </style>
          </head>
          <body>
            <div class="content">
              ${buildEmailLogoImg(brand, logoUrl)}
              <h2>Verify Your New Email Address</h2>
              <p>Hello ${user.username},</p>
              <div class="admin-note">
                <strong>Note:</strong> An administrator has resent your email change verification link.
              </div>
              <p>You requested to change your email address from <strong>${user.email}</strong> to <strong>${user.pendingEmail}</strong>.</p>
              <p>Please verify your new email address by clicking the button below:</p>
              <p><a href="${verificationLink}" class="button" style="display: inline-block; padding: 12px 24px; background-color: #1a82e2; color: #ffffff; text-decoration: none; border-radius: 4px; margin: 20px 0;">Verify New Email Address</a></p>
              <p>Or copy and paste this link into your browser:</p>
              <p><a href="${verificationLink}">${verificationLink}</a></p>
              <p>This link will expire in 24 hours.</p>
              <p>If you did not request this email change, please contact support immediately.</p>
            </div>
          </body>
        </html>
    `;

      await EmailEvents.Send.publish({
        to: user.pendingEmail,
        subject: 'Verify Your New Email Address',
        body: emailBody,
      });

      // Update the resent timestamp
      user.pendingEmailSentAt = new Date();
      await userRepository.update(user);

      // Log admin action
      await logAuditEvent(
        {
          userId: user.id,
          action: EmailAuditEvents.ADMIN_EMAIL_CHANGE_RESENT,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || 'unknown',
          adminUserId: req.user.id,
          adminUsername: req.user.username,
          oldEmail: user.email || undefined,
          newEmail: user.pendingEmail || undefined,
        },
        req.logger
      );

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
