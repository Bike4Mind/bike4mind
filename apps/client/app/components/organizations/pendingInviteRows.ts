import { OrgInviteRole, roleForPermissions } from '@bike4mind/common';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';

/** Who a resend or cancel names: the invite routes accept exactly one of the two. */
export type PendingInviteTarget = { email: string } | { userId: string };

export interface PendingInviteRow {
  key: string;
  inviteId: string;
  /** The invitee's name, their address, or a masked address. */
  label: string;
  /** Null for a masked address: the viewer never typed it, so no route can be asked to act on it. */
  target: PendingInviteTarget | null;
  role: OrgInviteRole | null;
  sentAt: Date | null;
  inviterId: string | null;
  inviterName: string | null;
}

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = new Date(value as string | Date);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * One row per pending recipient across the team's open invites, newest first. A recipient entry
 * is shaped by inviteManager.toSharerInviteViews: a user id named in `recipientUsers`, an address
 * the viewer typed, or a masked address.
 */
export function buildPendingInviteRows(invites: readonly ISharerInviteView[]): PendingInviteRow[] {
  const rows = invites.flatMap(invite => {
    const names = new Map((invite.recipientUsers ?? []).map(user => [user.userId, user.name]));
    const role = 'permissions' in invite ? roleForPermissions(invite.permissions) : null;
    return (invite.recipients?.pending ?? []).map((entry): PendingInviteRow => {
      const named = names.get(entry);
      const isAddress = entry.includes('@');
      const target: PendingInviteTarget | null =
        named !== undefined || !isAddress ? { userId: entry } : entry.includes('*') ? null : { email: entry };
      return {
        key: `${invite.id}:${entry}`,
        inviteId: invite.id,
        label: named || (isAddress ? entry : 'Unknown user'),
        target,
        role,
        sentAt: toDate(invite.createdAt),
        inviterId: invite.inviterId ? String(invite.inviterId) : null,
        inviterName: invite.inviterName ?? null,
      };
    });
  });
  return rows.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
}
