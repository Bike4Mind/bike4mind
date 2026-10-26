import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { InviteType } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  inviteRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';

async function unlockFromOrgInvite(userId: string, inviteId?: string) {
  return userService.unlockSignupGrant(userId, 'org_invite', {
    db: {
      users: userRepository,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason: 'Accepted organization invite',
    validators: {
      org_invite: async user => {
        const enabled = await adminSettingsRepository.findBySettingName('signupGrantOrgInviteEnabled');
        if (enabled?.settingValue !== 'true' && (enabled?.settingValue as unknown) !== true) return false;
        const email = user.email;
        if (!email) return false;
        const memberships = await organizationRepository.findMembershipOrgIds(user.id);
        if (!memberships.length) return false;
        // Recover an earlier failed release using persisted acceptance, even after the invite
        // leaves the pending inbox. Bound the lookup to organizations the caller still belongs to.
        const invite = inviteId
          ? await inviteRepository.findById(inviteId)
          : await inviteRepository.findOne({
              type: InviteType.Organization,
              documentId: { $in: memberships },
              'recipients.accepted': { $regex: `^${escapeRegex(email)}$`, $options: 'i' },
            });
        if (invite?.type !== InviteType.Organization) return false;
        if (!invite.recipients?.accepted.some(recipient => recipient.toLowerCase() === email.toLowerCase()))
          return false;
        return memberships.includes(invite.documentId);
      },
    },
  });
}

export async function unlockSignupGrantFromOrgInvite(userId: string, inviteId: string) {
  return unlockFromOrgInvite(userId, inviteId);
}

export async function unlockSignupGrantFromAcceptedOrgInvite(userId: string) {
  return unlockFromOrgInvite(userId);
}
