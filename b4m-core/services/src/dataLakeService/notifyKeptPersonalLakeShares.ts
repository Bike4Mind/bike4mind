import type { IUserRepository } from '@bike4mind/common';
import type { KeptPersonalLakeShares } from './reportKeptPersonalLakeShares';
import { escapeHtml, wrapLakeEmail } from './renderSpendNotificationEmail';
import type { LakeConfigAuditLogger } from './resolveLakeConfigAuditRetention';

type LakeRef = KeptPersonalLakeShares['byOwner'][number]['lakes'][number];

export interface KeptPersonalLakeSharesEmailInput {
  memberName: string;
  organizationName: string;
  lakes: LakeRef[];
  appUrl?: string;
}

export function renderKeptPersonalLakeSharesEmail(input: KeptPersonalLakeSharesEmailInput): {
  subject: string;
  html: string;
} {
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ');
  const isSingle = input.lakes.length === 1;
  const what = isSingle ? `"${input.lakes[0].name}"` : `${input.lakes.length} of your data lakes`;
  const shareWord = isSingle ? 'a share' : 'shares';
  const member = escapeHtml(input.memberName);
  const org = escapeHtml(input.organizationName);
  const items = input.lakes.map(lake => `<li>${escapeHtml(lake.name)}</li>`).join('');
  // There is no per-lake URL for the access view (it is a modal in the Data Lakes manager).
  const link = input.appUrl ? ` <a href="${escapeHtml(input.appUrl)}">Open the app</a>` : '';
  return {
    subject: oneLine(`${input.memberName} has left ${input.organizationName} and still has ${shareWord} on ${what}`),
    html: wrapLakeEmail(
      `<p>${member} has left ${org} and still has ${shareWord} on:</p><ul>${items}</ul>` +
        `<p>Leaving an organization does not remove shares you granted on your own data lakes. To review or ` +
        `remove them, open Data Lakes, select the lake and choose Access.${link}</p>`,
      'You are receiving this because you own these data lakes.'
    ),
  };
}

export interface KeptPersonalLakeSharesNotifyDeps {
  db: { users: Pick<IUserRepository, 'findByIds' | 'findActiveEmailsByIds'> };
  /** Mirrors the app-layer MailService.sendEmail signature. */
  mailer: { sendEmail(to: string, data: { subject: string; html: string }): Promise<unknown> };
  logger?: LakeConfigAuditLogger;
}

/**
 * Email each owner of a personal lake on which the departing member retains a grant, one message
 * per owner. Best-effort and never throws: call it after the departure commits, and a mail failure
 * must not fail the departure.
 */
export async function notifyKeptPersonalLakeShares(
  shares: KeptPersonalLakeShares,
  context: { departedUserId: string; organizationName: string; appUrl?: string },
  deps: KeptPersonalLakeSharesNotifyDeps
): Promise<void> {
  if (shares.byOwner.length === 0) return;
  const warn = (msg: string, meta: unknown) =>
    deps.logger?.warn ? deps.logger.warn(msg, meta) : console.warn(msg, meta);
  try {
    const [[member], emailRows] = await Promise.all([
      deps.db.users.findByIds([context.departedUserId]),
      deps.db.users.findActiveEmailsByIds(shares.byOwner.map(o => o.ownerUserId)),
    ]);
    const memberName = member?.name || member?.username || member?.email || 'A former member';
    const emails = new Map(emailRows.map(u => [u.id, u.email]));
    const skippedOwnerIds = shares.byOwner.map(o => o.ownerUserId).filter(id => !emails.has(id));
    if (skippedOwnerIds.length > 0) {
      warn('[dataLakes] kept-personal-lake-share owner has no emailed account; skipping', {
        departedUserId: context.departedUserId,
        skippedOwnerIds,
      });
    }
    // A rejection (rather than the sendEmail-failed `false`) propagates to the outer catch below.
    const results = await Promise.all(
      shares.byOwner.flatMap(({ ownerUserId, lakes }) => {
        const to = emails.get(ownerUserId);
        if (!to) return [];
        return [
          deps.mailer.sendEmail(
            to,
            renderKeptPersonalLakeSharesEmail({
              memberName,
              organizationName: context.organizationName,
              lakes,
              appUrl: context.appUrl,
            })
          ),
        ];
      })
    );
    // MailService (apps/client/server/utils/mailer) resolves false on a send failure and a truthy
    // send result otherwise, never throwing. Treat anything falsy as failed so that contract moving
    // cannot quietly hold this at zero.
    const failed = results.filter(result => !result).length;
    if (failed > 0) warn('[dataLakes] some kept-personal-lake-share emails failed', { failed });
  } catch (err) {
    warn('[dataLakes] kept-personal-lake-share notification failed', { error: String(err) });
  }
}
