import { IFabFile, IGroup, IInviteDocument, IOrganization, ISession, InviteType } from '@bike4mind/common';
import { FabFile, Group, Organization, Session, User } from '@bike4mind/database';

export const getInviteDetails = async (invite: IInviteDocument, includeUser?: boolean) => {
  const inviteWithDetails = invite;
  let name: string | undefined = '';
  let userId = undefined;
  const docId = invite.documentId;
  switch (invite.type) {
    case InviteType.FabFile: {
      const file: IFabFile | null = await FabFile.findById(docId);
      userId = file?.userId;
      name = file?.fileName;
      break;
    }
    case InviteType.Session: {
      const session: ISession | null = await Session.findById(docId);
      userId = session?.userId;
      name = session?.name;
      break;
    }
    case InviteType.Organization: {
      const org: IOrganization | null = await Organization.findById(docId);
      name = org?.name;
      break;
    }
    case InviteType.Group: {
      const group: IGroup | null = await Group.findById(docId);
      name = group?.name;
      break;
    }
    default:
      break;
  }

  if (includeUser && userId) {
    const user = await User.findById(userId);
    if (user) {
      inviteWithDetails.username = user.username;
    }
  }

  if (name) {
    inviteWithDetails.name = name;
  }

  return inviteWithDetails;
};
