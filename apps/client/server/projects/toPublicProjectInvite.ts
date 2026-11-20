import { isLinkOnlyInvite, PROJECT_INVITE_PERMISSIONS } from '@bike4mind/common';
import type { InviteType, ProjectInvite } from '@bike4mind/common';

type RecipientLists = { pending?: string[]; accepted?: string[]; refused?: string[] };

const toIso = (value: unknown) => (value ? new Date(value as string | Date).toISOString() : null);
const knownPermission = (p: unknown): p is ProjectInvite['permissions'][number] =>
  (PROJECT_INVITE_PERMISSIONS as readonly unknown[]).includes(p);

/**
 * Renders one entry of toSharerInviteViews (managers/inviteManager.ts) on the public wire. Takes the
 * sharer view, never a raw invite, so recipient addresses stay withheld and the token never appears.
 */
export function toPublicProjectInvite(view: Record<string, unknown>): ProjectInvite {
  const raw = (view.recipients ?? {}) as RecipientLists;
  const recipients = { pending: raw.pending ?? [], accepted: raw.accepted ?? [], refused: raw.refused ?? [] };
  const recipientUsers = (view.recipientUsers ?? []) as Array<{ userId: string; name: string }>;
  return {
    id: String(view.id ?? view._id),
    permissions: ((view.permissions ?? []) as unknown[]).filter(knownPermission),
    recipients,
    recipient_users: recipientUsers.map(u => ({ user_id: u.userId, name: u.name ?? '' })),
    description: typeof view.description === 'string' ? view.description : null,
    link_only: isLinkOnlyInvite({
      isLinkOnly: view.isLinkOnly as boolean | undefined,
      recipients,
      type: view.type as InviteType,
    }),
    uses_remaining: typeof view.remaining === 'number' ? view.remaining : 0,
    expires_at: toIso(view.expiresAt),
    created_at: toIso(view.createdAt),
  };
}
