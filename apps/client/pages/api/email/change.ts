import { requireEnv } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService } from '@bike4mind/services';
import { EmailEvents } from '@server/utils/eventBus';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { generateVerificationLink, getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { logAuditEvent, EmailAuditEvents } from '@server/utils/auditLog';
import { z } from 'zod';

const ChangeEmailRequestSchema = z.object({
  newEmail: z.email(),
});

// Requires authentication - users change their own email
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .use(
    rateLimit({
      limit: 3, // 3 attempts
      windowMs: 15 * 60 * 1000, // 15 minutes
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const { newEmail } = ChangeEmailRequestSchema.parse(req.body);

      // Buffer emails so they are published AFTER the transaction commits.
      // Publishing to SQS inside a transaction would mean a rollback can't
      // un-publish the message, leading to emails sent for a write that didn't persist.
      const pendingEmails: Array<{ to: string; subject: string; body: string }> = [];

      await withTransaction(async () => {
        await userService.requestEmailChange(
          {
            userId: req.user.id,
            newEmail,
          },
          {
            db: {
              users: {
                findById: async (id: string) => userRepository.findById(id),
                findByEmail: async (email: string) => userRepository.findByEmail(email),
                update: async user => userRepository.update(user),
              },
            },
            mailer: {
              sendEmailChangeNotification: async (user, pendingNewEmail) => {
                const brand = process.env.APP_NAME || '';
                const logoUrl = getLogoUrl();
                const baseUrl = requireEnv('APP_URL', process.env.APP_URL);
                // The `action=cancel-email-change` param is handled client-side by
                // ChangeEmailCard (CANCEL_EMAIL_CHANGE_ACTION), which opens the cancel
                // confirmation dialog. Keep the literal in sync with that handler.
                const cancelUrl = `${baseUrl}/profile?action=cancel-email-change`;

                const notificationBody = `
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
                background-color: #dc3545;
                color: #ffffff;
                text-decoration: none;
                border-radius: 4px;
                margin: 20px 0;
              }
              .warning {
                background-color: #f8d7da;
                border-left: 4px solid #dc3545;
                padding: 12px;
                margin: 20px 0;
              }
            </style>
          </head>
          <body>
            <div class="content">
              ${buildEmailLogoImg(brand, logoUrl)}
              <h2>Email Change Request</h2>
              <p>Hello ${user.username},</p>
              <p>We're writing to inform you that a request has been made to change the email address associated with your account.</p>
              <p><strong>Current email:</strong> ${user.email}</p>
              <p><strong>New email:</strong> ${pendingNewEmail}</p>
              <div class="warning">
                <strong>Security Alert:</strong> If you did NOT request this change, please cancel it immediately and secure your account.
              </div>
              <p>To cancel this email change request, click the button below:</p>
              <p><a href="${cancelUrl}" class="button">Cancel Email Change</a></p>
              <p>If you requested this change, no action is needed. The new email address will need to be verified before the change takes effect.</p>
              <p>If you have concerns about your account security, please contact our support team immediately.</p>
            </div>
          </body>
        </html>
      `;
                pendingEmails.push({
                  to: user.email!,
                  subject: 'Security Alert: Email Change Request',
                  body: notificationBody,
                });
              },
              sendEmailChangeVerification: async (user, pendingNewEmail, token) => {
                const brand = process.env.APP_NAME || '';
                const logoUrl = getLogoUrl();
                const verificationLink = `${generateVerificationLink(token).replace('/verify-email', '/verify-change')}`;

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
              .warning {
                background-color: #fff3cd;
                border-left: 4px solid #ffc107;
                padding: 12px;
                margin: 20px 0;
              }
            </style>
          </head>
          <body>
            <div class="content">
              ${buildEmailLogoImg(brand, logoUrl)}
              <h2>Confirm Email Address Change</h2>
              <p>Hello ${user.username},</p>
              <p>You requested to change your email address from <strong>${user.email}</strong> to <strong>${pendingNewEmail}</strong>.</p>
              <p>To confirm this change, please click the button below:</p>
              <p><a href="${verificationLink}" class="button" style="display: inline-block; padding: 12px 24px; background-color: #1a82e2; color: #ffffff; text-decoration: none; border-radius: 4px; margin: 20px 0;">Confirm Email Change</a></p>
              <p>Or copy and paste this link into your browser:</p>
              <p><a href="${verificationLink}">${verificationLink}</a></p>
              <div class="warning">
                <strong>Important:</strong> This link will expire in 24 hours. Once confirmed, you will need to log in using your new email address.
              </div>
              <p>If you did not request this email change, please ignore this email and your email address will remain unchanged.</p>
            </div>
          </body>
        </html>
      `;
                pendingEmails.push({
                  to: pendingNewEmail,
                  subject: 'Confirm Your Email Address Change',
                  body: emailBody,
                });
              },
            },
          }
        );

        // Log email change request (inside transaction - part of the write)
        await logAuditEvent(
          {
            userId: req.user.id,
            action: EmailAuditEvents.EMAIL_CHANGE_REQUESTED,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            oldEmail: req.user.email || undefined,
            newEmail,
          },
          req.logger
        );
      });

      // Publish emails after the transaction commits - prevents SQS messages from
      // being sent for a DB write that never persisted. The DB write is the source of
      // truth: a publish failure here must NOT 500 the request (which would falsely
      // signal the change didn't happen) - log it and let SQS's own retry/DLQ recover.
      for (const email of pendingEmails) {
        try {
          await EmailEvents.Send.publish(email);
        } catch (err) {
          req.logger.error('Failed to publish email-change notification after commit', {
            userId: req.user.id,
            to: email.to,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return res.json({ message: 'Email change verification sent. Please check your new email address.' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
