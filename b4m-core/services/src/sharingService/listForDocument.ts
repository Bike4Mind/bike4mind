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
import { secureParameters, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const listInvitesForDocumentSchema = z.object({
  documentId: z.string(),
  type: z.enum(InviteType),
});

type ListInvitesForDocumentParameters = z.infer<typeof listInvitesForDocumentSchema>;

interface ListInvitesForDocumentAdapters {
  db: {
    invites: Pick<IInviteRepository, 'findAllByDocumentId'>;
    fabFiles: Pick<IFabFileRepository, 'shareable'>;
    sessions: Pick<ISessionRepository, 'shareable'>;
    projects: Pick<IProjectRepository, 'shareable'>;
    organizations: Pick<IOrganizationRepository, 'shareable' | 'findById'>;
    groups: { findById: (id: string) => Promise<IGroupDocument | null> };
  };
}

/**
 * Lists every invite on a shareable document. Share-scoped: the caller must have
 * share access to the document (owner or a users[]-with-share grant), matching the
 * app-level CASL `Permission.share` this replaced. NOTE: the group-share arm CASL
 * also matched is not covered by `findShareAccessById` - a small pre-existing
 * narrowing shared with `createInvite`/`cancelInvite`.
 */
export const listInvitesForDocument = async (
  user: IUserDocument,
  parameters: ListInvitesForDocumentParameters,
  { db }: ListInvitesForDocumentAdapters
): Promise<IInviteDocument[]> => {
  const { documentId, type } = secureParameters(parameters, listInvitesForDocumentSchema);

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
      authorized = user.isAdmin
        ? await db.organizations.findById(group.organizationId)
        : await db.organizations.shareable.findShareAccessById(user, group.organizationId);
    }
  }

  if (!authorized) throw new UnauthorizedError('Unauthorized');

  const invites = await db.invites.findAllByDocumentId(documentId);
  return invites.filter(invite => invite.type === type);
};
