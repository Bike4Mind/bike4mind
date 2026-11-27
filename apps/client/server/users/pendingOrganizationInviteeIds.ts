import { canAdministerOrganization, InviteType, type IUserDocument } from '@bike4mind/common';
import { Invite, organizationRepository, User } from '@bike4mind/database';

/** Matches pending recipients on the server so the organization picker never needs their emails. */
export async function findPendingOrganizationInviteeIds(
  user: IUserDocument,
  organizationId: string,
  candidateIds: string[]
): Promise<Set<string> | null> {
  const organization = await organizationRepository.findById(organizationId);
  if (!organization || !canAdministerOrganization(user, organization)) return null;
  if (candidateIds.length === 0) return new Set();

  const invites = await Invite.find(
    {
      type: InviteType.Organization,
      documentId: organizationId,
      remaining: { $gt: 0 },
      'recipients.pending.0': { $exists: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    },
    { 'recipients.pending': 1 }
  ).lean();
  const emails = [...new Set(invites.flatMap(invite => invite.recipients?.pending ?? []))];
  if (emails.length === 0) return new Set();

  const invitees = await User.find({ _id: { $in: candidateIds }, email: { $in: emails } }, { _id: 1 })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  return new Set(invitees.map(invitee => String(invitee._id)));
}
