import {
  ACCOUNT_DELETION_RETAINED_RECORDS,
  isPlaceholderValue,
  requireEnv,
  type AccountDeletionRetainedRecord,
  type AccountDeletionSource,
} from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';
import { buildEmailLogoImg, escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { PURGED_USER_DATA } from '@server/services/purgeDeletedUserData';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';

// The copy below describes what requestAccountDeletion and cancelAccountDeletion
// (apps/client/server/users/accountDeletion.ts) and completeAccountDeletion do - keep in sync.

export const formatDeletionDate = (date: Date): string =>
  `${date.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })} (UTC)`;

const layout = (heading: string, content: string): string => {
  const brand = process.env.APP_NAME || '';
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
      <h2>${heading}</h2>
      ${content}
    </div>
  </body>
</html>`;
};

export function accountDeletionScheduledEmailBody(
  scheduledFor: Date,
  signInUrl: string,
  { source, supportEmail }: { source?: AccountDeletionSource; supportEmail?: string } = {}
): string {
  const date = escapeHtml(formatDeletionDate(scheduledFor));
  // Support and admin schedules reach users who may be unable to sign in, so the cancel route cannot be the
  // sign-in page. The sender is a no-reply address, so only a configured support address is offered.
  if (source && source !== 'self') {
    const support = supportEmail ? escapeHtml(supportEmail) : '';
    const cancelRoute = support
      ? `Changed your mind? Email <a href="mailto:${support}">${support}</a> before cleanup starts and we will cancel the
      deletion.`
      : 'Changed your mind? Contact support before cleanup starts and we will cancel the deletion.';
    const intro =
      source === 'support'
        ? 'As you asked by email, your account is scheduled for deletion.'
        : 'Your account is scheduled for deletion.';
    return layout(
      'Your account is scheduled for deletion',
      `
      <p>${intro} Your cancellation period ends on
      <strong>${date}</strong>. Permanent deletion begins after that date. You have been
      signed out everywhere, your API keys and connected apps have been revoked, and your subscriptions have been
      canceled.</p>
      <p>${cancelRoute}</p>
      <div class="warning">
        <strong>If you did not ask for this</strong>, ${support ? `email <a href="mailto:${support}">${support}</a>` : 'contact support'} right away.
      </div>`
    );
  }
  return layout(
    'Your account is scheduled for deletion',
    `
      <p>Your cancellation period ends on <strong>${date}</strong>. Permanent deletion begins after that date.
      You can cancel until cleanup starts. You have been
      signed out everywhere, your API keys and connected apps have been revoked, and your subscriptions have been
      canceled.</p>
      <p>Changed your mind? <a href="${escapeHtml(signInUrl)}">Sign in</a> and choose Cancel deletion before cleanup starts.</p>
      <div class="warning">
        <strong>If this wasn't you</strong>, sign in to cancel the deletion, then change your password.
      </div>`
  );
}

export async function sendAccountDeletionScheduledEmail(
  to: string,
  scheduledFor: Date,
  opts: { source?: AccountDeletionSource } = {}
): Promise<void> {
  const signInUrl = `${requireEnv('APP_URL', process.env.APP_URL)}/login`;
  await EmailEvents.Send.publish({
    to,
    subject: `Your account deletion cancellation period ends on ${formatDeletionDate(scheduledFor)}`,
    body: accountDeletionScheduledEmailBody(scheduledFor, signInUrl, {
      ...opts,
      supportEmail: isPlaceholderValue(Config.SUPPORT_EMAIL) ? undefined : Config.SUPPORT_EMAIL,
    }),
  });
}

/** Cancelling restores access only, so the email says what the request turned off stays off. */
export function accountDeletionCancelledEmailBody(): string {
  return layout(
    'Your account deletion was cancelled',
    `
      <p>Your account is active again and will not be deleted.</p>
      <p>Cancelling restores access only. Your subscriptions stay canceled, your API keys, connected apps and
      integrations stay revoked, and the pages and Skill Market listings you published stay offline. Subscribe,
      reconnect and publish again to turn them back on.</p>
      <div class="warning">
        <strong>If this wasn't you</strong>, change your password.
      </div>`
  );
}

export async function sendAccountDeletionCancelledEmail(to: string): Promise<void> {
  await EmailEvents.Send.publish({
    to,
    subject: 'Your account deletion was cancelled',
    body: accountDeletionCancelledEmailBody(),
  });
}

/** What the purge removed, what is kept and why, and what outside providers hold. */
export function accountDeletionCompleteEmailBody(
  retained: readonly AccountDeletionRetainedRecord[] = ACCOUNT_DELETION_RETAINED_RECORDS
): string {
  const removedItems = PURGED_USER_DATA.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const retainedItems = retained
    .map(
      item =>
        `<li><strong>${escapeHtml(item.category)}</strong>: ${escapeHtml(item.reason)}. Kept for ${escapeHtml(item.retention)}.</li>`
    )
    .join('');
  const retainedSection = retained.length
    ? `<p>A few records are kept after deletion:</p><ul>${retainedItems}</ul>`
    : '<p>No records are kept after deletion.</p>';
  return layout(
    'Your account has been deleted',
    `
      <p>Your account has been permanently deleted.</p>
      <p>What we removed:</p>
      <ul>${removedItems}</ul>
      ${retainedSection}
      <p>Some data sits with outside providers. AI model providers already received the prompts you sent, and their
      own retention policies apply to them. Payment records are held by our payment processor and follow its
      retention.</p>`
  );
}

/**
 * Sent by completeAccountDeletion (./completeAccountDeletion.ts) once the account is gone, to the
 * address it read before the delete. That runs from the daily sweep
 * (apps/workers/src/cron/accountDeletionSweep.ts) once `deletion.scheduledFor` passes.
 */
export async function sendAccountDeletionCompleteEmail(to: string): Promise<void> {
  await EmailEvents.Send.publish({
    to,
    subject: 'Your account has been deleted',
    body: accountDeletionCompleteEmailBody(),
  });
}
