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
import { assertCanManageOrgGroups } from '../organizationService/groupMembership';

export interface InviteTypeAuthAdapters {
  fabFiles: Pick<IFabFileRepository, 'shareable'>;
  sessions: Pick<ISessionRepository, 'shareable'>;
  projects: Pick<IProjectRepository, 'shareable'>;
  organizations: Pick<IOrganizationRepository, 'findById'>;
  groups: { findById: (id: string) => Promise<IGroupDocument | null> };
}

export interface AuthorizeByInviteTypeOptions {
  /**
   * When true, Organization and Group arms additionally call assertCanManageOrgGroups after the
   * membership check. Use for mutation paths (cancelInviteById, refuseWholeInvite non-recipient
   * branch); omit for read-only paths (listInvitesForDocument) where bare membership suffices.
   */
  requireManageGroups?: boolean;
}

/**
 * Shared per-invite-type authorization for the invite-management flows that key off a
 * document id. Passes silently when authorized and throws otherwise, so callers can't
 * silently diverge on the type -> access mapping. FabFile, Session, and Project use the
 * `shareable` adapter (findShareAccessById). Organization and Group use findById +
 * isOrgMember. When requireManageGroups is set, the Org/Group arms additionally enforce
 * assertCanManageOrgGroups (billing owner, appointed org admin, or platform admin).
 */
export const authorizeByInviteType = async (
  user: IUserDocument,
  type: InviteType,
  documentId: string,
  db: InviteTypeAuthAdapters,
  options?: AuthorizeByInviteTypeOptions
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
      if (options?.requireManageGroups) assertCanManageOrgGroups(user, org);
      authorized = org;
    }
  } else if (type === InviteType.Group) {
    const group = await db.groups.findById(documentId);
    if (group) {
      const org = await db.organizations.findById(group.organizationId);
      if (org && isOrgMember(user, org)) {
        if (options?.requireManageGroups) assertCanManageOrgGroups(user, org);
        authorized = org;
      }
    }
  }

  if (!authorized) throw new UnauthorizedError('Unauthorized');
};
