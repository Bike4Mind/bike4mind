import { escapeHtml, wrapEmail } from '../notificationEmail';
import type { ApiKeyReownedNotifyDeps } from './notifyApiKeyReowned';

export type ApiKeyRevokedByOrgNotifyDeps = ApiKeyReownedNotifyDeps;

export function renderApiKeyRevokedByOrgEmail(
  keyName: string,
  organizationName: string
): { subject: string; html: string } {
  // Strip CR/LF to guard against header injection (both names are free-text user input).
  const subjectName = keyName.replace(/[\r\n]+/g, ' ');
  return {
    subject: `Your API key "${subjectName}" was revoked by your organization`,
    html: wrapEmail(
      `<p>Your API key <strong>${escapeHtml(keyName)}</strong>, billed to <strong>${escapeHtml(organizationName)}</strong>, ` +
        `was revoked by an administrator of that organization. Requests made with it are now refused. ` +
        `If you still need access, ask an administrator, or create a new key from your account settings.</p>`,
      'You are receiving this because you created this API key.'
    ),
  };
}

/**
 * Email a member whose org-billed key an org administrator revoked. Best-effort and never throws:
 * call it after the revoke commits, and a mail failure must not fail the revoke.
 */
export async function notifyApiKeyRevokedByOrg(
  context: { holderUserId: string; keyName: string; organizationName: string },
  deps: ApiKeyRevokedByOrgNotifyDeps
): Promise<void> {
  const warn = (msg: string, meta: unknown) =>
    deps.logger?.warn ? deps.logger.warn(msg, meta) : console.warn(msg, meta);
  try {
    const emailRows = await deps.db.users.findActiveEmailsByIds([context.holderUserId]);
    if (emailRows.length === 0) {
      warn('[userApiKey] key holder has no active email; skipping org revoke notification', {
        holderUserId: context.holderUserId,
      });
      return;
    }
    const result = await deps.mailer.sendEmail(
      emailRows[0].email,
      renderApiKeyRevokedByOrgEmail(context.keyName, context.organizationName)
    );
    if (!result) {
      warn('[userApiKey] org revoke notification email failed to send', { holderUserId: context.holderUserId });
    }
  } catch (err) {
    warn('[userApiKey] org revoke notification failed', { holderUserId: context.holderUserId, error: String(err) });
  }
}
