import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService } from '@bike4mind/services';
import { EmailEvents } from '@server/utils/eventBus';
import { rateLimit } from '@server/middlewares/rateLimit';
import { generateVerificationLink, getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { logAuditEvent, EmailAuditEvents } from '@server/utils/auditLog';
import { MailService } from '@server/utils/mailer';

// Requires authentication - users resend verification to themselves
const handler = baseApi({ auth: true })
  .use(
    rateLimit({
      limit: 3, // 3 attempts
      windowMs: 15 * 60 * 1000, // 15 minutes
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      // Check if email service is configured before attempting to send
      const mailService = new MailService();
      const emailConfig = mailService.getConfigStatus();

      if (!emailConfig.configured) {
        // Return different error messages based on user role
        if (req.user?.isAdmin) {
          return res.status(503).json({
            error: 'Email service not configured',
            message: `Email service is not properly configured. Missing secrets: ${emailConfig.missingSecrets.join(', ')}. Configure these in your SST secrets.`,
            isConfigError: true,
            missingSecrets: emailConfig.missingSecrets,
          });
        } else {
          return res.status(503).json({
            error: 'Email service temporarily unavailable',
            message: 'Unable to send verification email at this time. Please contact support or try again later.',
            isConfigError: true,
          });
        }
      }

      await withTransaction(async () => {
        await userService.resendEmailVerification(
          { userId: req.user.id },
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
            </style>
          </head>
          <body>
            <div class="content">
              ${buildEmailLogoImg(brand, logoUrl)}
              <h2>Verify Your Email Address</h2>
              <p>Hello ${user.username},</p>
              <p>You requested a new email verification link. Please verify your email address by clicking the button below:</p>
              <p><a href="${verificationLink}" class="button" style="display: inline-block; padding: 12px 24px; background-color: #1a82e2; color: #ffffff; text-decoration: none; border-radius: 4px; margin: 20px 0;">Verify Email Address</a></p>
              <p>Or copy and paste this link into your browser:</p>
              <p><a href="${verificationLink}">${verificationLink}</a></p>
              <p>This link will expire in 24 hours.</p>
              <p>If you did not request this, you can safely ignore this email.</p>
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

        // Log email resent event
        await logAuditEvent(
          {
            userId: req.user.id,
            action: EmailAuditEvents.EMAIL_VERIFICATION_RESENT,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
          },
          req.logger
        );

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
