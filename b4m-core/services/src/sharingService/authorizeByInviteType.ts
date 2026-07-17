import {
  IFabFileRepository,
  IGroupDocument,
  InviteType,
  IOrganizationRepository,
  IProjectRepository,
  ISessionRepository,
  IUserDocument,
} from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';

export interface InviteTypeAuthAdapters {
  fabFiles: Pick<IFabFileRepository, 'shareable'>;
  sessions: Pick<ISessionRepository, 'shareable'>;
  projects: Pick<IProjectRepository, 'shareable'>;
  organizations: Pick<IOrganizationRepository, 'shareable' | 'findById'>;
  groups: { findById: (id: string) => Promise<IGroupDocument | null> };
}

/**
 * Shared per-invite-type authorization for the invite-management flows that key off a
 * document id (listInvitesForDocument, cancelInviteById). Returns the authorizing doc
 * on success and throws UnauthorizedError otherwise, so callers can't silently diverge
 * on the type -> access mapping. Share access uses the `shareable` adapter
 * (owner / users-share / groups-share via findShareAccessById), matching the CASL
 * `Permission.share` arms this layer replaced. Organization keeps the admin bypass
 * (sibling create/cancel precedent); Group authorizes through its parent organization's
 * share access with no admin bypass (also matching create/cancel). Any other type
 * (e.g. Tool) has no arm and is denied.
 */
export const authorizeByInviteType = async (
  user: IUserDocument,
  type: InviteType,
  documentId: string,
  db: InviteTypeAuthAdapters
): Promise<unknown> => {
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
    const group = await db.groups.findById(documentId);
    if (group) {
      authorized = await db.organizations.shareable.findShareAccessById(user, group.organizationId);
    }
  }

  if (!authorized) throw new UnauthorizedError('Unauthorized');
  return authorized;
};
