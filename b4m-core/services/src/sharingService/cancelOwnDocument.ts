import {
  IFabFileDocument,
  IGroupDocument,
  IInvite,
  InviteType,
  IOrganizationDocument,
  ISessionDocument,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const cancelOwnDocumentInvitesSchema = z.object({
  documentId: z.string(),
  type: z.enum(InviteType),
});

type CancelOwnDocumentInvitesParameters = z.infer<typeof cancelOwnDocumentInvitesSchema>;

interface CancelOwnDocumentInvitesAdapters {
  db: {
    invites: {
      findByDocumentIdAndType: (userId: string, documentId: string, type: InviteType) => Promise<IInvite | null>;
      update: (data: IInvite) => Promise<unknown>;
    };
    sessions: {
      findByIdAndUserId: (id: string, userId: string) => Promise<ISessionDocument | null>;
    };
    fabFiles: {
      findByIdAndUserId: (id: string, userId: string) => Promise<IFabFileDocument | null>;
    };
    organizations: {
      findByIdAndUserId: (id: string, userId: string) => Promise<IOrganizationDocument | null>;
    };
    groups: {
      findById: (id: string) => Promise<IGroupDocument | null>;
    };
  };
}

export const cancelOwnDocumentInvites = async (
  userId: string,
  parameters: CancelOwnDocumentInvitesParameters,
  { db }: CancelOwnDocumentInvitesAdapters
) => {
  const { documentId, type } = secureParameters(parameters, cancelOwnDocumentInvitesSchema);

  if (type === InviteType.FabFile) {
    const fabFile = await db.fabFiles.findByIdAndUserId(documentId, userId);
    if (!fabFile) throw new NotFoundError('Fab file not found');
  } else if (type === InviteType.Session) {
    const session = await db.sessions.findByIdAndUserId(documentId, userId);
    if (!session) throw new NotFoundError('Session not found');
  } else if (type === InviteType.Organization) {
    const organization = await db.organizations.findByIdAndUserId(documentId, userId);
    if (!organization) throw new NotFoundError('Organization not found');
  } else if (type === InviteType.Group) {
    const group = await db.groups.findById(documentId);
    if (!group) throw new NotFoundError('Group not found');
    const organization = await db.organizations.findByIdAndUserId(group.organizationId, userId);
    if (!organization) throw new NotFoundError('Group not found');
  }

  const invite = await db.invites.findByDocumentIdAndType(userId, documentId, type);

  if (!invite) throw new NotFoundError('Invite not found');

  invite.remaining = 0;

  await db.invites.update(invite);

  return invite;
};
