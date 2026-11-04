import { InviteType, type SignupInvite } from '@bike4mind/common';
import { inviteRepository, User, userRepository } from '@bike4mind/database';

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
