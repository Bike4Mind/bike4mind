import { buildSuspensionNotice, type IUserRepository } from '@bike4mind/common';
import { escapeHtml, wrapEmail } from '../notificationEmail';

export interface AccountSuspendedNotifyDeps {
  db: { users: Pick<IUserRepository, 'findActiveEmailsByIds'> };
  /** Mirrors the app-layer MailService.sendEmail signature. */
  mailer: { sendEmail(to: string, data: { subject: string; html: string }): Promise<unknown> };
  logger?: { warn(msg: string, meta: unknown): void };
}

export type AccountSuspendedEmailContext = {
  category: unknown;
  supportEmail?: string;
  /** Absolute policy page URL; omitted when the deployment has no marketing site. */
  policyUrl?: string;
};

/**
 * The optional suspension email. Same sentence as the sign-in, in-app and API notices
 * (buildSuspensionNotice), so it names the rule and the appeal path and never what flagged the account.
 */
export function renderAccountSuspendedEmail({ category, supportEmail, policyUrl }: AccountSuspendedEmailContext): {
  subject: string;
  html: string;
} {
  const notice = buildSuspensionNotice(category, { email: supportEmail });
  const policyLink = policyUrl
    ? `<p>You can read the ${escapeHtml(notice.policy.name)} at <a href="${escapeHtml(policyUrl)}">${escapeHtml(policyUrl)}</a>.</p>`
    : '';
  return {
    subject: 'Your account has been suspended',
    html: wrapEmail(
      `<p>${escapeHtml(notice.message)}</p>${policyLink}` +
        '<p>While the account is suspended you cannot sign in or use the API. Your data is kept.</p>',
      'You are receiving this because an administrator suspended your account.'
    ),
  };
}

/**
 * Email the owner of a newly suspended account. Best-effort and never throws: call it after the
 * suspension commits, behind the `suspensionNoticeEmailEnabled` setting (off by default).
 */
export async function notifyAccountSuspended(
  context: AccountSuspendedEmailContext & { userId: string },
  deps: AccountSuspendedNotifyDeps
): Promise<void> {
  const warn = (msg: string, meta: unknown) =>
    deps.logger?.warn ? deps.logger.warn(msg, meta) : console.warn(msg, meta);
  try {
    const emailRows = await deps.db.users.findActiveEmailsByIds([context.userId]);
    if (emailRows.length === 0) {
      warn('[suspension] suspended user has no active email; skipping notice', { userId: context.userId });
      return;
    }
    const result = await deps.mailer.sendEmail(emailRows[0].email, renderAccountSuspendedEmail(context));
    if (!result) warn('[suspension] notice email failed to send', { userId: context.userId });
  } catch (err) {
    warn('[suspension] notice email failed', { userId: context.userId, error: String(err) });
  }
}
