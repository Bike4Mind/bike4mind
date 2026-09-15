import {
  IFabFileDocument,
  IGroupDocument,
  IInviteDocument,
  InviteType,
  IOrganizationDocument,
  ISessionDocument,
  IUserDocument,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const getInviteSchema = z.object({
  id: z.string(),
  withUsername: z.boolean().optional(),
});

type GetInviteParameters = z.infer<typeof getInviteSchema>;

interface GetInviteAdapters {
  db: {
    invites: {
      findByIdAndUserId: (id: string, userId: string) => Promise<IInviteDocument | null>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
    fabFiles: {
      findById: (id: string) => Promise<IFabFileDocument | null>;
    };
    sessions: {
      findById: (id: string) => Promise<ISessionDocument | null>;
    };
    organizations: {
      findById: (id: string) => Promise<IOrganizationDocument | null>;
    };
    groups: {
      findById: (id: string) => Promise<IGroupDocument | null>;
    };
  };
}

export const getInvite = async (userId: string, params: GetInviteParameters, { db }: GetInviteAdapters) => {
  const { id, withUsername } = secureParameters(params, getInviteSchema);

  const invite = await db.invites.findByIdAndUserId(id, userId);
  if (!invite) throw new NotFoundError('Invite not found');

  const inviteWithDetails: IInviteDocument = invite;
  let name: string | undefined = '';
  const docId = invite.documentId;
  let inviteUserId: string | undefined;
  switch (invite.type) {
    case InviteType.FabFile: {
      const file: IFabFileDocument | null = await db.fabFiles.findById(docId);
      inviteUserId = String(file?.userId);
      name = file?.fileName;
      break;
    }
    case InviteType.Session: {
      const session: ISessionDocument | null = await db.sessions.findById(docId);
      inviteUserId = session?.userId;
      name = session?.name;
      break;
    }
    case InviteType.Organization: {
      const org: IOrganizationDocument | null = await db.organizations.findById(docId);
      name = org?.name;
      break;
    }
    case InviteType.Group: {
      const group: IGroupDocument | null = await db.groups.findById(docId);
      name = group?.name;
      break;
    }
    default:
      break;
  }

  if (withUsername && inviteUserId) {
    const user = await db.users.findById(userId);
    if (user) {
      inviteWithDetails.username = user.username;
    }
  }

  if (name) {
    inviteWithDetails.name = name;
  }

  return inviteWithDetails;
};
