import { InviteType, type SignupInvite } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  inviteRepository,
  Organization,
  organizationRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
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
  if (!(invitedAt instanceof Date) || !(createdAt instanceof Date)) {
    console.warn('[org-invite-bonus] invite or account has no creation date; leaving the account unmarked');
    return false;
  }
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

/** A cheap precheck only: the seat reservation in payForPayingOrganization is the real gate. */
async function hasOpenBonusSeat(organizationId: string): Promise<boolean> {
  const organization = await Organization.findById(organizationId)
    .select('seats signupInviteBonusCount')
    .lean<{ seats?: number; signupInviteBonusCount?: number }>();
  const seats = organization?.seats ?? 0;
  return seats > 0 && (organization?.signupInviteBonusCount ?? 0) < seats;
}

/**
 * Pays the bonus to an account marked with `organizationId`'s invite, once its standing is confirmed
 * (here, unless the caller just did: `standingVerified`).
 * The seat and bonus commit in one transaction, so an interrupted payout cannot leave a seat held.
 * An account not yet eligible takes no hold and cannot crowd out an eligible one at the last seat.
 */
async function payForPayingOrganization(
  userId: string,
  organizationId: string,
  standingVerified = false
): Promise<number> {
  const user = await userRepository.findById(userId);
  if (user?.signupInvite?.source !== 'organization' || user.signupInvite.organizationId !== organizationId) return 0;
  if (!userService.isInviteBonusEligible(user, true)) return 0;
  if (!(await hasOpenBonusSeat(organizationId))) return 0;
  if (!standingVerified && !(await isPayingOrganization(organizationId))) return 0;
  const result = await userService.payInviteBonus(userId, {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    orgStandingVerified: true,
    reserveOrganizationBonusSeat: async () => {
      const reservation = await Organization.updateOne(
        {
          _id: organizationId,
          seats: { $gt: 0 },
          $expr: { $lt: [{ $ifNull: ['$signupInviteBonusCount', 0] }, '$seats'] },
        },
        { $inc: { signupInviteBonusCount: 1 } }
      );
      return reservation.modifiedCount === 1;
    },
  });
  return result.creditsGranted;
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
  return payForPayingOrganization(userId, invite.documentId, true);
}

/**
 * Recovers missing attribution from accepted invites in current organizations and retries an unpaid
 * bonus, re-checking that the organization still pays. Returns the credits paid.
 */
export async function retryOrgInviteBonus(userId: string): Promise<number> {
  const user = await userRepository.findById(userId);
  if (!user?.signupGrant || user.signupGrant.inviteBonusPaid != null) return 0;
  const signupInvite = user.signupInvite;
  if (signupInvite) {
    if (signupInvite.source !== 'organization' || !signupInvite.organizationId) return 0;
    return payForPayingOrganization(userId, signupInvite.organizationId);
  }
  if (!user.email || !(user.createdAt instanceof Date)) return 0;

  // Acceptance may commit before attribution fails, or arrive through an API key. Recover only
  // from accepted invitations to this inbox in organizations the account still belongs to.
  const organizationIds = await organizationRepository.findMembershipOrgIds(userId);
  for (const organizationId of organizationIds.toSorted()) {
    const invite = await inviteRepository.findOne({
      type: InviteType.Organization,
      documentId: organizationId,
      createdAt: { $lte: user.createdAt },
      'recipients.accepted': { $regex: `^${escapeRegex(user.email)}$`, $options: 'i' },
    });
    if (!invite) continue;
    const credits = await payOrgInviteBonus(userId, invite.id);
    if (credits > 0 || (await userRepository.findById(userId))?.signupInvite) return credits;
  }
  return 0;
}
