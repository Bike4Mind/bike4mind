import { escapeHtml, wrapEmail } from '../notificationEmail';
import type { ApiKeyReownedNotifyDeps } from './notifyApiKeyReowned';
import { Logger } from '@bike4mind/observability';

export type ApiKeyExpiringNotifyDeps = ApiKeyReownedNotifyDeps;

export function renderApiKeyExpiringEmail(
  keyName: string,
  expiresAt: Date,
  renewUrl: string | null
): { subject: string; html: string } {
  // Strip CR/LF to guard against header injection (key name is free-text user input).
  const subjectName = keyName.replace(/[\r\n]+/g, ' ');
  const date = expiresAt.toISOString().slice(0, 10);
  const renew = renewUrl
    ? `<p><a href="${escapeHtml(renewUrl)}">Create a replacement key</a> before then to avoid an interruption.</p>`
    : '<p>Create a replacement key from your account settings before then to avoid an interruption.</p>';
  return {
    subject: `Your API key "${subjectName}" expires on ${date}`,
    html: wrapEmail(
      `<p>Your API key <strong>${escapeHtml(keyName)}</strong> expires on <strong>${date}</strong>. ` +
        `After that, requests made with it are refused.</p>${renew}`,
      'You are receiving this because you created this API key.'
    ),
  };
}

/**
 * Email the owner of an API key that is about to expire. Never throws, so one bad address cannot stop a
 * sweep. Resolves false when the send failed and is worth retrying; true when it was queued, or when the
 * owner has no active email (nothing a retry could fix).
 */
export async function notifyApiKeyExpiring(
  context: { holderUserId: string; keyName: string; expiresAt: Date; renewUrl: string | null },
  deps: ApiKeyExpiringNotifyDeps
): Promise<boolean> {
  const warn = (msg: string, meta: unknown) =>
    deps.logger?.warn ? deps.logger.warn(msg, meta) : Logger.warn(msg, meta);
  try {
    const emailRows = await deps.db.users.findActiveEmailsByIds([context.holderUserId]);
    if (emailRows.length === 0) {
      warn('[userApiKey] key holder has no active email; skipping expiry reminder', {
        holderUserId: context.holderUserId,
      });
      return true;
    }
    const result = await deps.mailer.sendEmail(
      emailRows[0].email,
      renderApiKeyExpiringEmail(context.keyName, context.expiresAt, context.renewUrl)
    );
    if (!result) {
      warn('[userApiKey] expiry reminder email failed to send', { holderUserId: context.holderUserId });
    }
    return !!result;
  } catch (err) {
    warn('[userApiKey] expiry reminder failed', { holderUserId: context.holderUserId, error: String(err) });
    return false;
  }
}
