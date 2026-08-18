import { api } from '@client/app/contexts/ApiContext';
import {
  FileGeneratePresignedUrlRequestInputType,
  FileGeneratePresignedUrlResponseType,
  IOrganization,
  IOrganizationDocument,
  TableQuery,
  WithId,
} from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { AxiosResponse, isAxiosError } from 'axios';
import { uploadFileToUrl } from './uploadFileToUrl';

export const fetchOrganizations = async (): Promise<IOrganizationDocument[]> => {
  try {
    const response = await api.get('/api/organizations');
    return response.data.organizations ?? [];
  } catch (error) {
    console.error('Error fetching organizations:', error);
    return [];
  }
};

// Mutation hooks using react-query
// NOTE: org creation deliberately does NOT live here. `POST /api/organizations` is admin-only,
// and its one caller is the admin panel via `useCreateOrganization` in
// app/hooks/data/organizations.ts. An unused duplicate here would 403 for any non-admin surface
// that picked it up, surfacing as a generic toast rather than a permission error.
export function useUpdateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, organizationData }: { orgId: string; organizationData: Partial<IOrganization> }) => {
      const { data } = await api.put(`/api/organizations/${orgId}`, organizationData);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Organization updated successfully!');
    },
    onError: (error: unknown) => {
      if (isAxiosError(error)) {
        toast.error(error.response?.data?.error);
        return;
      }

      console.error('Failed to update organization:', error);
      toast.error('Failed to update organization. Please try again.');
    },
  });
}

export function useDeleteOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orgId: string) => {
      await api.delete(`/api/organizations/${orgId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Organization deleted successfully!');
    },
    onError: (error: unknown) => {
      console.error('Failed to delete organization:', error);
      toast.error('Failed to delete organization. Please try again.');
    },
  });
}

export const getOrganizationUsers = async <T, U>(params: z.infer<typeof TableQuery>) => {
  const response = await api.get<{ data: T; meta: U }>('/api/organizations/users', { params });
  return response.data;
};

/**
 * Fetches the organization associated with a user.
 */
export function useGetUserOrganization(
  /** User ID */
  userId: string | undefined | null
) {
  return useQuery({
    queryKey: ['users', userId, 'organization'],
    queryFn: async () => {
      const { data } = await api.get<WithId<IOrganization> | null>(`/api/users/${userId}/organization`);
      return data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    enabled: !!userId,
  });
}

/**
 * Fetches all organizations.
 */
export function useGetAllOrganizations(queryParams?: Record<string, unknown>) {
  return useQuery({
    queryKey: ['organizations', queryParams],
    queryFn: async () => {
      const { data } = await api.get<{ data: IOrganizationDocument[]; hasMore: boolean; total: number }>(
        '/api/organizations',
        {
          params: queryParams,
        }
      );
      return data.data ?? [];
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useOrganizationStats(ids: string[]) {
  return useQuery({
    queryKey: ['organizations', 'stats', ids],
    queryFn: async () => {
      const response = await api.get('/api/organizations/stats', {
        params: {
          organizationIds: ids,
        },
      });
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    enabled: ids.length > 0,
  });
}

/**
 * Fetch organization data for a given organization ID.
 */
export function useGetOrganization(orgId: string | null | undefined) {
  return useQuery({
    queryKey: ['organizations', orgId],
    queryFn: async () => {
      try {
        const { data } = await api.get<WithId<IOrganization>>(`/api/organizations/${orgId}`);
        return data;
      } catch (error) {
        console.error('Error fetching organization:', error);
        return null;
      }
    },
    enabled: !!orgId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUploadOrganizationLogo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      organizationId,
      fileInfo,
      file,
    }: {
      organizationId: string;
      /** Logo image in base64 format */
      fileInfo: FileGeneratePresignedUrlRequestInputType;
      file: File | Blob;
    }) => {
      const { data } = await api.post<
        FileGeneratePresignedUrlResponseType,
        AxiosResponse<FileGeneratePresignedUrlResponseType>,
        FileGeneratePresignedUrlRequestInputType
      >(`/api/organizations/${organizationId}/upload-logo`, fileInfo);

      const { url, fileId } = data;

      // The shared helper handles both shapes the server can hand back: an S3 presign (hosted,
      // raw axios) and the same-origin app-file upload proxy (self-host, authed api).
      await uploadFileToUrl(url, file, file.type);

      return fileId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
}
