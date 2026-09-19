import {
  IFabFileRepository,
  IGroupDocument,
  InviteType,
  IOrganizationRepository,
  IProjectRepository,
  ISessionRepository,
  IUserDocument,
  isOrgMember,
} from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';

export interface InviteTypeAuthAdapters {
  fabFiles: Pick<IFabFileRepository, 'shareable'>;
  sessions: Pick<ISessionRepository, 'shareable'>;
  projects: Pick<IProjectRepository, 'shareable'>;
  organizations: Pick<IOrganizationRepository, 'findById'>;
  groups: { findById: (id: string) => Promise<IGroupDocument | null> };
}

/**
 * Shared per-invite-type authorization for the invite-management flows that key off a
 * document id (listInvitesForDocument, cancelInviteById). Passes silently when the
 * caller is authorized and throws UnauthorizedError otherwise, so callers can't silently
 * diverge on the type -> access mapping. FabFile, Session, and Project use the
 * `shareable` adapter (findShareAccessById). Organization and Group use findById +
 * membership predicate via isOrgMember (billing owner, orgAclRowConfersMembership users[] row, or
 * platform admin). Any other type (e.g. Tool) has no arm and
 * is denied.
 */
export const authorizeByInviteType = async (
  user: IUserDocument,
  type: InviteType,
  documentId: string,
  db: InviteTypeAuthAdapters
): Promise<void> => {
  let authorized: unknown = null;

  if (type === InviteType.FabFile) {
    authorized = await db.fabFiles.shareable.findShareAccessById(user, documentId);
  } else if (type === InviteType.Session) {
    authorized = await db.sessions.shareable.findShareAccessById(user, documentId);
  } else if (type === InviteType.Project) {
    authorized = await db.projects.shareable.findShareAccessById(user, documentId);
  } else if (type === InviteType.Organization) {
    const org = await db.organizations.findById(documentId);
    if (org && isOrgMember(user, org)) {
      authorized = org;
    }
  } else if (type === InviteType.Group) {
    const group = await db.groups.findById(documentId);
    if (group) {
      const org = await db.organizations.findById(group.organizationId);
      if (org && isOrgMember(user, org)) {
        authorized = org;
      }
    }
  }

  if (!authorized) throw new UnauthorizedError('Unauthorized');
};
