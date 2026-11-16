import { InviteType, type IInviteDocument } from '@bike4mind/common';

/**
 * Distinct, lowercased addresses still pending on live Organization invites: the seats named
 * invites hold. `invites` is one organization's findAllByDocumentId result. Every seat check
 * (create.ts inviteToOrg, accept.ts link joins, the bulk-invite route) counts through this.
 */
export const pendingOrgInviteRecipients = (invites: IInviteDocument[], now: Date = new Date()): string[] =>
  Array.from(
    new Set(
      invites
        .filter(
          invite =>
            invite.type === InviteType.Organization &&
            invite.remaining > 0 &&
            !invite.revokedAt &&
            (!invite.expiresAt || new Date(invite.expiresAt) > now)
        )
        .flatMap(invite => invite.recipients?.pending ?? [])
        .map(address => address.trim().toLowerCase())
    )
  );
