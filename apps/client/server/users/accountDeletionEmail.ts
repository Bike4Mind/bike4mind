import { requireEnv } from '@bike4mind/common';
import { buildEmailLogoImg, escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { EmailEvents } from '@server/utils/eventBus';

export const formatDeletionDate = (date: Date): string =>
  `${date.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })} (UTC)`;

export function accountDeletionScheduledEmailBody(scheduledFor: Date, signInUrl: string): string {
  const brand = process.env.APP_NAME || '';
  const date = escapeHtml(formatDeletionDate(scheduledFor));
  return `
<!DOCTYPE html>
<html>
  <head>
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.5; color: #333333; }
      .content { margin: 20px; }
      .logo { display: block; margin-bottom: 20px; }
      a { color: #1a82e2; }
      .warning { background-color: #f8d7da; border-left: 4px solid #dc3545; padding: 12px; margin: 20px 0; }
    </style>
  </head>
  <body>
    <div class="content">
      ${buildEmailLogoImg(brand)}
      <h2>Your account is scheduled for deletion</h2>
      <p>Your account and its data will be permanently deleted on <strong>${date}</strong>. Until then you have been
      signed out everywhere, your API keys and connected apps have been revoked, and your subscriptions have been
      canceled.</p>
      <p>Changed your mind? <a href="${escapeHtml(signInUrl)}">Sign in</a> before that date and choose Cancel deletion.</p>
      <div class="warning">
        <strong>If this wasn't you</strong>, sign in to cancel the deletion, then change your password.
      </div>
    </div>
  </body>
</html>`;
}

export async function sendAccountDeletionScheduledEmail(to: string, scheduledFor: Date): Promise<void> {
  const signInUrl = `${requireEnv('APP_URL', process.env.APP_URL)}/login`;
  await EmailEvents.Send.publish({
    to,
    subject: `Your account is scheduled for deletion on ${formatDeletionDate(scheduledFor)}`,
    body: accountDeletionScheduledEmailBody(scheduledFor, signInUrl),
  });
}
