import { api } from '@client/app/contexts/ApiContext';
import { IInviteDocument, IInviteDocumentWithDetails, InviteType } from '@bike4mind/common';
import { isNull, isUndefined, pickBy } from 'lodash';

export const fetchInvite = async (id: string): Promise<IInviteDocumentWithDetails | null> => {
  try {
    const response = await api.get(`/api/invites/${id}`);

    if (response.status === 200) {
      return response.data;
    } else {
      console.error('Failed fetching Invite');
      return null;
    }
  } catch (error) {
    console.error('Error fetching Invite:', error);
    return null;
  }
};

export interface IInvitesResponse {
  data: IInviteDocumentWithDetails[];
  pagination?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export const fetchUserInvites = async (userId: string): Promise<IInviteDocumentWithDetails[]> => {
  const MAX_RETRIES = 2;
  let retries = 0;

  const attemptFetch = async (): Promise<IInviteDocumentWithDetails[]> => {
    try {
      const response = await api.get(`/api/users/${userId}/userInvites`);

      if (response.status === 200) {
        return response.data.data;
      } else {
        console.error('Failed fetching Invites', response.status);
        return [];
      }
    } catch (error: any) {
      // Check if we've hit a rate limit or API throttling error
      if (error?.response?.status === 429 || (error?.message && error.message.includes('rate'))) {
        if (retries < MAX_RETRIES) {
          // Exponential backoff: wait longer with each retry
          const delayMs = Math.pow(2, retries) * 1000;
          console.log(`Rate limited, retrying after ${delayMs}ms...`);

          retries++;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          return attemptFetch();
        }
      }

      console.error('Error fetching Invites:', error);
      return [];
    }
  };

  return attemptFetch();
};

export interface IGetInvitesRequest {
  projectId: string;
  statuses?: string;
  limit: number;
  page: number;
}

export interface IGetInvitesResponse {
  data: IInviteDocumentWithDetails[];
  totalPages: number;
  total: number;
}

export const fetchProjectInvites = async (
  projectId: string,
  params: { statuses?: string } = {}
): Promise<IGetInvitesResponse> => {
  const response = await api.get(`/api/projects/${projectId}/invites`, { params });
  return response.data;
};

// Map InviteType enum values to API paths
const INVITE_TYPE_TO_API_PATH = {
  [InviteType.FabFile]: 'files',
  [InviteType.Session]: 'sessions',
  [InviteType.Project]: 'projects',
  [InviteType.Group]: 'groups',
  [InviteType.Organization]: 'organizations',
  [InviteType.Tool]: 'tools',
};

export const shareDocument = async (data: {
  id: string;
  type: string;
  recipients?: string[] | null;
  expiresAt?: Date | null;
  available?: number | null;
  description?: string | null;
  permissions: string[];
}) => {
  const { type, id, ...rest } = data;
  const filteredData = pickBy(rest, value => !isNull(value) && !isUndefined(value));

  const apiPath = INVITE_TYPE_TO_API_PATH[type as InviteType] || type;

  const response = await api.post(`/api/${apiPath}/${id}/invites`, filteredData);
  if (response.status === 200) {
    return response.data;
  }
};

export const acceptDocument = async (id: string, isPublic: boolean = false) => {
  const response = await api.post<IInviteDocument>(`/api/invites/${id}/accept`, { public: isPublic });
  if (response.status === 200) {
    return response.data;
  }
};

export const refuseDocument = async (id: string, isPublic: boolean = false) => {
  const response = await api.post(`/api/invites/${id}/refuse`, { public: isPublic });
  if (response.status === 200) {
    return response.data;
  }
};
