import { escapeHtml, wrapEmail } from '../notificationEmail';
import type { ApiKeyReownedNotifyDeps } from '../userApiKeyService/notifyApiKeyReowned';

export type SpaceDomainReleasedNotifyDeps = ApiKeyReownedNotifyDeps;

export function renderSpaceDomainReleasedEmail(spaceName: string, domain: string): { subject: string; html: string } {
  // Strip CR/LF to guard against header injection (both values are free-text user input).
  const subjectSpace = spaceName.replace(/[\r\n]+/g, ' ');
  const subjectDomain = domain.replace(/[\r\n]+/g, ' ');
  return {
    subject: `"${subjectSpace}" no longer holds ${subjectDomain}`,
    html: wrapEmail(
      `<p>Your Space <strong>${escapeHtml(spaceName)}</strong> no longer holds the domain <strong>${escapeHtml(domain)}</strong>. ` +
        `Another party has verified ownership of it, and a domain has one verified holder. ` +
        `People who already joined your Space through that domain stay. New domain joins have stopped.</p>`,
      'You are receiving this because you own this Space.'
    ),
  };
}

/**
 * Email the owner of a Space whose verified domain claim was released. Best-effort and never throws:
 * call it after the release commits, and a mail failure must not fail the release.
 */
export async function notifySpaceDomainReleased(
  context: { ownerUserId: string; spaceName: string; domain: string },
  deps: SpaceDomainReleasedNotifyDeps
): Promise<void> {
  const warn = (msg: string, meta: unknown) =>
    deps.logger?.warn ? deps.logger.warn(msg, meta) : console.warn(msg, meta);
  try {
    const emailRows = await deps.db.users.findActiveEmailsByIds([context.ownerUserId]);
    if (emailRows.length === 0) {
      warn('[spaces] Space owner has no active email; skipping domain release notification', {
        ownerUserId: context.ownerUserId,
      });
      return;
    }
    const result = await deps.mailer.sendEmail(
      emailRows[0].email,
      renderSpaceDomainReleasedEmail(context.spaceName, context.domain)
    );
    if (!result) {
      warn('[spaces] domain release notification email failed to send', { ownerUserId: context.ownerUserId });
    }
  } catch (err) {
    warn('[spaces] domain release notification failed', { ownerUserId: context.ownerUserId, error: String(err) });
  }
}
