import { InviteType, type IUserDocument } from '@bike4mind/common';
import { Invite, projectRepository, User } from '@bike4mind/database';

/**
 * Which of `candidateIds` are named in an open invite to the project, or null when `user` lacks
 * share access to it. Lets the member picker mark pending invitees without returning their email:
 * project invites store recipients as emails, so the match happens here, server-side. Gated on
 * share access like the project invite list (projectService.listInvites), which already shows
 * those invitees to the same callers.
 */
export async function findPendingProjectInviteeIds(
  user: IUserDocument,
  projectId: string,
  candidateIds: string[]
): Promise<Set<string> | null> {
  const project = await projectRepository.shareable.findShareAccessById(user, projectId);
  if (!project) return null;
  if (candidateIds.length === 0) return new Set();

  // remaining > 0 mirrors the project Members list's notion of a still-open invite.
  const invites = await Invite.find(
    {
      type: InviteType.Project,
      documentId: projectId,
      remaining: { $gt: 0 },
      'recipients.pending.0': { $exists: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    },
    { 'recipients.pending': 1 }
  ).lean();
  const emails = [...new Set(invites.flatMap(invite => invite.recipients?.pending ?? []))];
  if (emails.length === 0) return new Set();

  // Case-insensitive, matching how sharingService resolves recipients (findAllByEmailsOrUsernames).
  const invitees = await User.find({ _id: { $in: candidateIds }, email: { $in: emails } }, { _id: 1 })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  return new Set(invitees.map(invitee => String(invitee._id)));
}
