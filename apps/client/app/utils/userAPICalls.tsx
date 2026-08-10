import {
  FileGeneratePresignedUrlResponseType,
  FileGeneratePresignedUrlRequestInputType,
  IUser,
} from '@bike4mind/common';
import type { AdminUserListItem } from './adminUserProjection';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import axios, { AxiosResponse } from 'axios';
import type { MetadataFilter } from '@server/analytics/metadataFilterContract';
import { api } from '@client/app/contexts/ApiContext';
import { uploadFileToUrl } from './uploadFileToUrl';

export const updateUserToServer = async (userId: string, userData: Partial<IUser>) => {
  const { data } = await api.put(`/api/users/${userId}/update`, userData);

  return data;
};

export interface IGetUsersParams {
  page: number;
  limit: number;
  search?: string;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  orgSearch?: string[];
  tags?: string[];
  projectId?: string;
  publicView?: boolean;
}

export interface IGetUsersResponse {
  // Derived from the endpoint's projection, so reading a field GET /api/users does not
  // emit is a compile error. publicView requests return only the PUBLIC_USER_LIST_PROJECTION
  // subset of these fields.
  users: AdminUserListItem[];
  currentPage: number;
  totalPages: number;
  totalUsers: number;
}

export const fetchUsers = async (params: IGetUsersParams & { downloadAll?: boolean }): Promise<IGetUsersResponse> => {
  try {
    const response = await api.get<IGetUsersResponse>('/api/users', { params });
    return response.data;
  } catch (error) {
    console.error('Error fetching users:', error);
    return { users: [], currentPage: 1, totalPages: 1, totalUsers: 0 };
  }
};

export interface FetchCounterLogsParams {
  startDate?: string;
  endDate?: string;
  events?: string[];
  report?: boolean;
  includeInsights?: boolean;
  orgs?: string[] | null;
  excludeOrgs?: string[] | null;
  isGated?: boolean;
  isHero?: boolean;
  weeklyReport?: boolean;
  page?: number;
  limit?: number;
  counterName?: string;
  userEmail?: string;
  metadataFilters?: MetadataFilter[];
}

/**
 * Both report modes answer on the same `reports` key with different envelopes: the daily one
 * carries `date`, the weekly one the week's bounds. Hence the optional keys rather than a
 * discriminated union - which key is set follows the request flag, not anything in the payload.
 */
export interface AnalyticsReport {
  date?: string;
  startDate?: string;
  endDate?: string;
  report: string;
  aiInsights?: string | null;
}

/** One rendered User Activity row: the server groups per day/counter/user/metadata. */
export interface CounterLogRow {
  date: string;
  counterName: string;
  userId?: string;
  userEmail?: string;
  userOrganization?: string;
  metadata?: Record<string, unknown>;
  count: number;
  totalValue: number;
}

interface CounterLogsResponse {
  logs?: CounterLogRow[];
  reports?: AnalyticsReport[];
  total?: number;
}

export const fetchCounterLogs = async ({
  startDate,
  endDate,
  events,
  report = false,
  includeInsights = false,
  orgs = null,
  excludeOrgs = null,
  isGated,
  isHero,
  weeklyReport = false,
  page,
  limit,
  counterName,
  userEmail,
  metadataFilters,
}: FetchCounterLogsParams): Promise<CounterLogsResponse> => {
  const queryParams: Record<string, string> = {
    startDate: startDate || '',
    endDate: endDate || '',
  };

  // Handle arrays by joining with commas and encoding each value
  if (events?.length) {
    queryParams.events = events.map(e => encodeURIComponent(e)).join(',');
  }
  if (report) queryParams.report = 'true';
  if (weeklyReport) queryParams.weeklyReport = 'true';
  if (includeInsights) queryParams.includeInsights = 'true';
  if (orgs?.length) {
    queryParams.orgs = orgs.map(org => encodeURIComponent(org)).join(',');
  }
  if (excludeOrgs?.length) {
    queryParams.excludeOrgs = excludeOrgs.map(org => encodeURIComponent(org)).join(',');
  }
  if (isGated !== undefined) queryParams.isGated = String(isGated);
  if (isHero !== undefined) queryParams.isHero = String(isHero);
  if (page !== undefined) queryParams.page = String(page);
  if (limit !== undefined) queryParams.limit = String(limit);
  if (counterName) queryParams.counterName = counterName;
  if (userEmail) queryParams.userEmail = userEmail;
  if (metadataFilters?.length) queryParams.metadataFilters = JSON.stringify(metadataFilters);

  // Deliberately unguarded: a failure here (e.g. the 502 an oversized response used to
  // produce) must reach react-query so the UI can say "failed" instead of "no data".
  const response = await api.get('/api/users/counterLogs', { params: queryParams });
  return response.data;
};

export function useMigrateUsers() {
  return useMutation({
    mutationFn: async (data: {
      usersData: { name: string; email: string }[];
      setTemporaryPassword?: boolean;
      sendEmail?: boolean;
      orgId?: string;
    }) => {
      const response = await api.post('/api/reg-invites/migrate', data);
      return response.data;
    },
    onSuccess: data => {
      toast.success('Users migrated successfully!');
      return data;
    },
    onError: (error: unknown) => {
      console.error('Failed to migrate users:', error);

      let errorMessage = 'Failed to migrate users. Please try again.';
      let errorCode = '';

      if (axios.isAxiosError(error)) {
        errorCode = error.response?.status?.toString() || '';

        if (error.response) {
          // Handle specific error responses
          if (error.response.status === 400 && error.response.data?.error) {
            errorMessage = `Migration failed: ${error.response.data.error}`;
          } else if (error.response.status === 503) {
            errorMessage = 'Service is temporarily unavailable. Please try again later.';
          } else {
            // For other error statuses, use a generic message with the status code
            errorMessage = `Migration failed with status code ${error.response.status}. Please try again.`;
          }
        } else if (error.request) {
          // The request was made but no response was received
          errorMessage = 'No response received from server. Please check your connection and try again.';
        } else {
          // Something happened in setting up the request that triggered an Error
          errorMessage = 'An error occurred while setting up the request. Please try again.';
        }
      }

      // Include error code in the toast message if available
      const fullErrorMessage = errorCode ? `[Error ${errorCode}] ${errorMessage}` : errorMessage;
      toast.error(fullErrorMessage);
    },
  });
}

export function useUploadProfilePhoto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      userId,
      fileInfo,
      file,
    }: {
      userId: string;
      fileInfo: FileGeneratePresignedUrlRequestInputType;
      file: File | Blob;
    }) => {
      const { data } = await api.post<
        FileGeneratePresignedUrlResponseType,
        AxiosResponse<FileGeneratePresignedUrlResponseType>,
        FileGeneratePresignedUrlRequestInputType
      >(`/api/users/${userId}/upload-photo`, fileInfo);

      const { url, fileId } = data;

      // The shared helper handles both shapes the server can hand back: an S3 presign (hosted,
      // raw axios) and the same-origin app-file upload proxy (self-host, authed api).
      await uploadFileToUrl(url, file, file.type);

      return fileId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export const fetchUserTags = async (): Promise<{ tags: string[] }> => {
  try {
    const response = await api.get<{ tags: string[] }>('/api/users/tags');
    return response.data;
  } catch (error) {
    console.error('Error fetching user tags:', error);
    return { tags: [] };
  }
};
