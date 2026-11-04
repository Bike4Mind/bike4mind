import { InviteType, type SignupInvite } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  inviteRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import { isPayingOrganization } from '@server/entitlements/orgPaidStanding';

/**
 * Marks `userId` as having signed up through organization invite `inviteId`. The caller decides
 * the organization qualifies (it must be paying); this checks only that the account is new to the
 * invite: created after the invite was sent, holding a signup grant (SSO/SAML accounts get none),
 * and not already marked. Returns whether this call set the field; a replay or a concurrent accept
 * is a no-op through the conditional update.
 */
export async function recordOrgSignupInvite(userId: string, inviteId: string): Promise<boolean> {
  const [invite, user] = await Promise.all([inviteRepository.findById(inviteId), userRepository.findById(userId)]);
  if (!invite || invite.type !== InviteType.Organization || !invite.documentId) return false;
  if (!user?.signupGrant || user.signupInvite) return false;

  // InviteModel sets timestamps, but the shared invite type does not declare createdAt.
  const invitedAt = (invite as { createdAt?: unknown }).createdAt;
  const createdAt = user.createdAt;
  if (!(invitedAt instanceof Date) || !(createdAt instanceof Date)) return false;
  if (createdAt.getTime() < invitedAt.getTime()) return false;

  const signupInvite: SignupInvite = {
    source: 'organization',
    inviteId: invite.id,
    organizationId: invite.documentId,
    at: new Date(),
  };
  const result = await User.updateOne(
    { _id: userId, signupInvite: { $exists: false } },
    { $set: { signupInvite } }
  ).exec();
  return result.modifiedCount === 1;
}

/**
 * Marks and pays the invite bonus for a new account that accepted a paying organization's invite.
 * An unpaid organization's invite leaves the account uninvited. Returns the credits paid.
 */
export async function payOrgInviteBonus(userId: string, inviteId: string): Promise<number> {
  const invite = await inviteRepository.findById(inviteId);
  if (invite?.type !== InviteType.Organization || !invite.documentId) return 0;
  if (!(await isPayingOrganization(invite.documentId))) return 0;
  await recordOrgSignupInvite(userId, inviteId);
  const result = await userService.payInviteBonus(userId, {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
  });
  return result.creditsGranted;
}
