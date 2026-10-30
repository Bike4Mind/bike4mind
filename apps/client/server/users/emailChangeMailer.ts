import { requireEnv, type IUserDocument } from '@bike4mind/common';
import {
  generateVerificationLink,
  getLogoUrl,
  buildEmailLogoImg,
  escapeHtml,
} from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { EmailEvents } from '@server/utils/eventBus';

export type EmailChangeMessage = { to: string; subject: string; body: string };

type EmailChangeUser = Pick<IUserDocument, 'username' | 'email'>;

const ADMIN_NOTES = {
  started: 'An administrator started this email change on your behalf.',
  resent: 'An administrator has resent your email change verification link.',
} as const;

const buildAdminNote = (text: string) => `
              <div class="admin-note" style="background-color: #e3f2fd; border-left: 4px solid #2196f3; padding: 12px; margin: 20px 0;">
                <strong>Note:</strong> ${text}
              </div>`;

/**
 * The mailer `userService.requestEmailChange` takes. Messages are buffered into `outbox` rather than
 * sent, so the caller publishes them only after its transaction commits (publishEmailChangeMessages).
 * `adminNote` adds a note that an administrator started the change or resent its link, and words the
 * verification email without claiming the user made the request.
 */
export const buildEmailChangeMailer = (
  outbox: EmailChangeMessage[],
  { adminNote: noteKind }: { adminNote?: keyof typeof ADMIN_NOTES } = {}
) => {
  const adminNote = noteKind ? buildAdminNote(ADMIN_NOTES[noteKind]) : '';
  return {
    sendEmailChangeNotification: async (user: EmailChangeUser, pendingNewEmail: string) => {
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
              <p>Hello ${escapeHtml(user.username)},</p>${adminNote}
              <p>We're writing to inform you that a request has been made to change the email address associated with your account.</p>
              <p><strong>Current email:</strong> ${escapeHtml(user.email ?? '')}</p>
              <p><strong>New email:</strong> ${escapeHtml(pendingNewEmail)}</p>
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
      outbox.push({
        // requestEmailChange only notifies an account that has a current address.
        to: user.email!,
        subject: 'Security Alert: Email Change Request',
        body: notificationBody,
      });
    },
    sendEmailChangeVerification: async (user: EmailChangeUser, pendingNewEmail: string, token: string) => {
      const brand = process.env.APP_NAME || '';
      const logoUrl = getLogoUrl();
      const verificationLink = `${generateVerificationLink(token).replace('/verify-email', '/verify-change')}`;
      // An emailless account (OAuth signup with no provider-verified email) uses this
      // same flow to add its first address, so there is no "from" address to name.
      const requested = noteKind ? 'A request was made' : 'You requested';
      const intro = user.email
        ? `${requested} to change your email address from <strong>${escapeHtml(user.email)}</strong> to <strong>${escapeHtml(pendingNewEmail)}</strong>.`
        : `${requested} to add <strong>${escapeHtml(pendingNewEmail)}</strong> as the email address on your account.`;

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
              <h2>${user.email ? 'Confirm Email Address Change' : 'Confirm Your Email Address'}</h2>
              <p>Hello ${escapeHtml(user.username)},</p>${adminNote}
              <p>${intro}</p>
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
      outbox.push({
        to: pendingNewEmail,
        subject: user.email ? 'Confirm Your Email Address Change' : 'Confirm Your Email Address',
        body: emailBody,
      });
    },
  };
};

/**
 * Publishes buffered email-change messages after the write commits. The DB write is the source of
 * truth: a publish failure must not fail the request (which would falsely signal the change did not
 * happen), so a failed publish is logged for investigation. A message that never reaches SQS
 * cannot be recovered by the queue's retry or DLQ handling.
 */
export const publishEmailChangeMessages = async (
  outbox: readonly EmailChangeMessage[],
  logger: { error: (message: string, meta: Record<string, unknown>) => void },
  userId: string
): Promise<void> => {
  for (const email of outbox) {
    try {
      await EmailEvents.Send.publish(email);
    } catch (err) {
      logger.error('Failed to publish email-change notification after commit', {
        userId,
        to: email.to,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
