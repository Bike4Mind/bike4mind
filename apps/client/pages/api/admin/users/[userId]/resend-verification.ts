import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { userService } from '@bike4mind/services';
import { EmailEvents } from '@server/utils/eventBus';
import { generateVerificationLink, getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { logAuditEvent, EmailAuditEvents } from '@server/utils/auditLog';

interface RequestQuery {
  userId: string;
}

// Admin-only endpoint to resend email verification for a specific user
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
        await userService.resendEmailVerification(
          { userId },
          {
            db: {
              users: userRepository,
            },
            mailer: {
              sendEmailVerificationEmail: async (user, token) => {
                const brand = process.env.APP_NAME || '';
                const logoUrl = getLogoUrl();
                const verificationLink = generateVerificationLink(token);

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
              <h2>Verify Your Email Address</h2>
              <p>Hello ${user.username},</p>
              <div class="admin-note">
                <strong>Note:</strong> An administrator has resent your email verification link.
              </div>
              <p>Please verify your email address by clicking the button below:</p>
              <p><a href="${verificationLink}" class="button" style="display: inline-block; padding: 12px 24px; background-color: #1a82e2; color: #ffffff; text-decoration: none; border-radius: 4px; margin: 20px 0;">Verify Email Address</a></p>
              <p>Or copy and paste this link into your browser:</p>
              <p><a href="${verificationLink}">${verificationLink}</a></p>
              <p>This link will expire in 24 hours.</p>
              <p>If you did not request this verification or create an account, you can safely ignore this email.</p>
            </div>
          </body>
        </html>
      `;
                await EmailEvents.Send.publish({
                  to: user.email!,
                  subject: 'Verify Your Email Address',
                  body: emailBody,
                });
              },
            },
          }
        );

        // Log admin action
        await logAuditEvent(
          {
            userId,
            action: EmailAuditEvents.ADMIN_VERIFICATION_RESENT,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            adminUserId: req.user.id,
            adminUsername: req.user.username,
          },
          req.logger
        );

        req.logger.info(`Admin ${req.user.id} resent email verification for user ${userId}`);

        return res.json({ message: 'Verification email resent successfully' });
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
