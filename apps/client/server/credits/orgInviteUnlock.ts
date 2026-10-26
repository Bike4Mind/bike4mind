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

export async function unlockSignupGrantFromOrgInvite(userId: string, inviteId: string) {
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
        const invite = await inviteRepository.findById(inviteId);
        if (invite?.type !== InviteType.Organization || !user.email) return false;
        if (!invite.recipients?.accepted.some(email => email.toLowerCase() === user.email!.toLowerCase())) return false;
        const memberships = await organizationRepository.findMembershipOrgIds(user.id);
        return memberships.includes(invite.documentId);
      },
    },
  });
}
