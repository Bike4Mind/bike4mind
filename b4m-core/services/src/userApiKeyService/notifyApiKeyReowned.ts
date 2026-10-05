import type { IUserRepository } from '@bike4mind/common';
import { escapeHtml, wrapLakeEmail } from '../dataLakeService/renderSpendNotificationEmail';

export interface ApiKeyReownedNotifyDeps {
  db: { users: Pick<IUserRepository, 'findActiveEmailsByIds'> };
  /** Mirrors the app-layer MailService.sendEmail signature. */
  mailer: { sendEmail(to: string, data: { subject: string; html: string }): Promise<unknown> };
}

export function renderApiKeyReownedEmail(keyName: string): { subject: string; html: string } {
  const escaped = escapeHtml(keyName);
  // Strip CR/LF to guard against header injection (key name is free-text user input).
  const subjectName = keyName.replace(/[\r\n]+/g, ' ');
  return {
    subject: `Your API key "${subjectName}" was rotated to a new owner`,
    html: wrapLakeEmail(
      `<p>Your API key <strong>${escaped}</strong> was rotated by an org admin and is now owned by that admin. ` +
        `The credential you previously held is no longer valid. ` +
        `If you need a new key, you can create one from your account settings.</p>`,
      'You are receiving this because you previously owned this API key.'
    ),
  };
}

/**
 * Email the previous owner of a re-owned API key. Best-effort and never throws: call it
 * after the rotation commits, and a mail failure must not fail the rotation.
 */
export async function notifyApiKeyReowned(
  context: { previousOwnerUserId: string; keyName: string },
  deps: ApiKeyReownedNotifyDeps
): Promise<void> {
  const warn = (msg: string, meta: unknown) => console.warn(msg, meta);
  try {
    const emailRows = await deps.db.users.findActiveEmailsByIds([context.previousOwnerUserId]);
    if (emailRows.length === 0) {
      warn('[userApiKey] previous key owner has no active email; skipping re-own notification', {
        previousOwnerUserId: context.previousOwnerUserId,
      });
      return;
    }
    const result = await deps.mailer.sendEmail(emailRows[0].email, renderApiKeyReownedEmail(context.keyName));
    if (!result) {
      warn('[userApiKey] re-own notification email failed to send', {
        previousOwnerUserId: context.previousOwnerUserId,
      });
    }
  } catch (err) {
    warn('[userApiKey] re-own notification failed', {
      previousOwnerUserId: context.previousOwnerUserId,
      error: String(err),
    });
  }
}
