import {
  IFabFileDocument,
  IGroupDocument,
  IInviteDocument,
  InviteType,
  IOrganizationRepository,
  ISessionDocument,
  IUserDocument,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const cancelInviteSchema = z.object({
  id: z.string(),
  type: z.enum(InviteType),
  email: z.email().optional(),
});

type CancelInviteParameters = z.infer<typeof cancelInviteSchema>;

interface CancelInviteAdapters {
  db: {
    invites: {
      findAllByDocumentId: (documentId: string) => Promise<IInviteDocument[]>;
      update: (data: IInviteDocument) => Promise<unknown>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
    sessions: {
      findByIdAndUserId: (id: string, userId: string) => Promise<ISessionDocument | null>;
    };
    fabFiles: {
      findByIdAndUserId: (id: string, userId: string) => Promise<IFabFileDocument | null>;
    };
    organizations: IOrganizationRepository;
    groups: {
      findById: (id: string) => Promise<IGroupDocument | null>;
    };
  };
}

/**
 * Cancels remaining invites for a document.
 */
export const cancelInvite = async (
  user: IUserDocument,
  parameters: CancelInviteParameters,
  { db }: CancelInviteAdapters
) => {
  const { id, type, email } = secureParameters(parameters, cancelInviteSchema);
  if (!user.email) throw new Error('User has no email');

  if (type === InviteType.FabFile) {
    const fabFile = await db.fabFiles.findByIdAndUserId(id, user.id);
    if (!fabFile) throw new NotFoundError('Fab file not found');
  } else if (type === InviteType.Session) {
    const session = await db.sessions.findByIdAndUserId(id, user.id);
    if (!session) throw new NotFoundError('Session not found');
  } else if (type === InviteType.Organization) {
    const organizationa = user.isAdmin
      ? await db.organizations.findById(id)
      : await db.organizations.shareable.findShareAccessById(user, id);
    if (!organizationa) throw new NotFoundError('Organization not found');
  } else if (type === InviteType.Group) {
    const group = await db.groups.findById(id);
    if (!group) throw new NotFoundError('Group not found');

    const organization = await db.organizations.shareable.findShareAccessById(user, group.organizationId);
    if (!organization) throw new NotFoundError('Group not found');
  }

  const invites = await db.invites.findAllByDocumentId(id);
  if (invites.length === 0) throw new Error('Invite not found');

  for (const invite of invites) {
    // If email is provided, we need to remove it from the pending list
    if (email && invite.recipients?.pending) {
      invite.recipients.pending = invite.recipients.pending?.filter(p => p !== email);
      invite.remaining -= 1;
    } else {
      invite.remaining = 0;
    }
    await db.invites.update(invite);
  }

  return invites;
};
