import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { InviteType, signupGrantRemaining } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  inviteRepository,
  organizationRepository,
  Organization,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

async function unlockFromOrgInvite(userId: string, inviteId?: string) {
  return userService.unlockSignupGrant(userId, 'org_invite', {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason: 'Accepted organization invite',
    validators: {
      org_invite: async user => {
        // Validation runs before the engine's zero-delta return. A replay must not
        // reserve another organization slot when no payout remains.
        if (!user.signupGrant || signupGrantRemaining(user.signupGrant) <= 0) return false;
        const enabled = await adminSettingsRepository.findBySettingName('signupGrantOrgInviteEnabled');
        if (enabled?.settingValue !== 'true' && (enabled?.settingValue as unknown) !== true) return false;
        const email = user.email;
        if (!email) return false;
        const memberships = await organizationRepository.findMembershipOrgIds(user.id);
        if (!memberships.length) return false;
        // Recover an earlier failed release using persisted acceptance, even after the invite
        // leaves the pending inbox. Bound the lookup to organizations the caller still belongs to.
        for (const organizationId of memberships) {
          const invite = inviteId
            ? await inviteRepository.findById(inviteId)
            : await inviteRepository.findOne({
                type: InviteType.Organization,
                documentId: organizationId,
                'recipients.accepted': { $regex: `^${escapeRegex(email)}$`, $options: 'i' },
              });
          if (invite?.type !== InviteType.Organization) continue;
          if (!invite.recipients?.accepted.some(recipient => recipient.toLowerCase() === email.toLowerCase())) continue;
          if (invite.documentId !== organizationId) continue;
          // All grants for one org write the same document inside the payout transaction.
          // Mongo retries a conflicting transaction, rechecking its capacity. The durable
          // counter survives member/account deletion and rolls back if the payout fails.
          const organization = await organizationRepository.findById(organizationId);
          if (!organization || !Number.isSafeInteger(organization.seats) || organization.seats <= 0) continue;
          const missingCounter = { _id: organizationId, signupGrantUnlockCount: { $exists: false } };
          if (await Organization.exists(missingCounter)) {
            const unlocked = await userRepository.count({ 'signupGrant.unlockedOrgId': invite.documentId });
            await Organization.updateOne(missingCounter, { $set: { signupGrantUnlockCount: unlocked } });
          }
          const reservation = await Organization.updateOne(
            { _id: organizationId, $expr: { $lt: ['$signupGrantUnlockCount', '$seats'] } },
            { $inc: { signupGrantUnlockCount: 1 } }
          );
          if (reservation.modifiedCount === 1) return { unlockedOrgId: organizationId };
        }
        return false;
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
