import { api } from '@client/app/contexts/ApiContext';
import {
  IFabFileDocument,
  InviteType,
  IProjectDocument,
  ISessionDocument,
  IShareableDocument,
} from '@bike4mind/common';
import { isAxiosError } from 'axios';

export const updateSharingOnServer = async (type: string, id: string, sharingData: Partial<IShareableDocument>) => {
  const response = await api.put(`/api/${type}/${id}/updateSharing`, sharingData);
  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error(`Failed to share ${type}`);
  }
};

type RevokeSharingType = {
  [InviteType.FabFile]: IFabFileDocument;
  [InviteType.Session]: ISessionDocument;
  [InviteType.Project]: IProjectDocument;
};

const SHAREABLE_TYPES_PATHS = {
  [InviteType.FabFile]: 'files',
  [InviteType.Session]: 'sessions',
  [InviteType.Project]: 'projects',
};

export const revokeSharingOnServer = async <T extends InviteType.FabFile | InviteType.Session | InviteType.Project>(
  type: T,
  id: string,
  userId: string
) => {
  const response = await api.post<RevokeSharingType[T]>(`/api/${SHAREABLE_TYPES_PATHS[type]}/${id}/revokeSharing`, {
    userId,
  });

  if (isAxiosError(response)) {
    throw new Error(`Failed to revoke sharing for ${type}`);
  }

  return response.data as RevokeSharingType[T];
};
