import {
  IFabFileRepository,
  IGroupDocument,
  IInviteDocument,
  IInviteRepository,
  InviteType,
  IOrganizationRepository,
  IProjectRepository,
  ISessionRepository,
  IUserDocument,
} from '@bike4mind/common';
import { NotFoundError, secureParameters, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const cancelInviteByIdSchema = z.object({
  id: z.string(),
});

type CancelInviteByIdParameters = z.infer<typeof cancelInviteByIdSchema>;

interface CancelInviteByIdAdapters {
  db: {
    invites: Pick<IInviteRepository, 'findById' | 'update'>;
    fabFiles: Pick<IFabFileRepository, 'shareable'>;
    sessions: Pick<ISessionRepository, 'shareable'>;
    projects: Pick<IProjectRepository, 'shareable'>;
    organizations: Pick<IOrganizationRepository, 'shareable' | 'findById'>;
    groups: { findById: (id: string) => Promise<IGroupDocument | null> };
  };
}

/**
 * Cancels a SINGLE invite by its invite id (distinct from `cancelInvite`, which
 * cancels every invite on a document). Zeroes `remaining` and clears the pending
 * list but keeps `refused`. Share-scoped: the caller must have share access to the
 * invite's document, replacing the manager's CASL `Permission.share` check.
 */
export const cancelInviteById = async (
  user: IUserDocument,
  parameters: CancelInviteByIdParameters,
  { db }: CancelInviteByIdAdapters
): Promise<IInviteDocument | null> => {
  const { id } = secureParameters(parameters, cancelInviteByIdSchema);

  const invite = await db.invites.findById(id);
  if (!invite) throw new NotFoundError('Invite not found');

  const { type, documentId } = invite;

  let authorized: unknown = null;
  if (type === InviteType.FabFile) {
    authorized = await db.fabFiles.shareable.findShareAccessById(user, documentId);
  } else if (type === InviteType.Session) {
    authorized = await db.sessions.shareable.findShareAccessById(user, documentId);
  } else if (type === InviteType.Project) {
    authorized = await db.projects.shareable.findShareAccessById(user, documentId);
  } else if (type === InviteType.Organization) {
    authorized = user.isAdmin
      ? await db.organizations.findById(documentId)
      : await db.organizations.shareable.findShareAccessById(user, documentId);
  } else if (type === InviteType.Group) {
    // Group share access is the parent org's share access, checked unconditionally
    // (no isAdmin short-circuit) to match the sibling `cancelInvite`/`createInvite`:
    // ability.ts grants admins read/update/delete on Organization but NOT share.
    const group = await db.groups.findById(documentId);
    if (group) {
      authorized = await db.organizations.shareable.findShareAccessById(user, group.organizationId);
    }
  }

  if (!authorized) throw new UnauthorizedError('Unauthorized');

  invite.remaining = 0;
  if (invite.recipients) {
    invite.recipients.pending = [];
  }

  await db.invites.update(invite);
  return db.invites.findById(id);
};
