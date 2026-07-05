import {
  FileGeneratePresignedUrlResponseType,
  FileGeneratePresignedUrlRequestInputType,
  IUser,
  IUserDocument,
  WithOrgRef,
} from '@bike4mind/common';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import axios, { AxiosResponse } from 'axios';
import { api } from '@client/app/contexts/ApiContext';

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
  users: WithOrgRef<IUserDocument>[];
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

interface FetchCounterLogsParams {
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
}

interface DailyReport {
  date: string;
  report: string;
  aiInsights?: string | null;
}

interface CounterLogsResponse {
  logs?: any[];
  reports?: DailyReport[];
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
}: FetchCounterLogsParams): Promise<CounterLogsResponse> => {
  try {
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

    const response = await api.get('/api/users/counterLogs', { params: queryParams });
    return response.data;
  } catch (error) {
    console.error('Error fetching counter logs:', error);
    return { logs: [], reports: [] };
  }
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

      await axios.put(url, file, {
        headers: {
          'Content-Type': file.type,
        },
      });

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
