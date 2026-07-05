import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  IOrganizationDocument,
  WithId,
  FileGeneratePresignedUrlRequestInputType,
  FileGeneratePresignedUrlResponseType,
} from '@bike4mind/common';
import { toast } from 'sonner';
import axios, { AxiosResponse } from 'axios';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { useGetOrganizationUsers, useGetPendingOrganizationUsers } from './user';
import { useMemo } from 'react';
import { getErrorMessage } from '@client/app/utils/error';

/**
 * Hook to search organizations with pagination and filtering
 * Uses infinite query pattern similar to useSearchProjects
 */
export function useSearchUserOrganizations(
  userId: string,
  search: string,
  filters?: {}, // Add additional filters here
  orderBy?: { by: 'name' | 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' },
  options?: { enabled?: boolean }
) {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: ['organizations', 'search', { userId, search, filters, orderBy }],
    initialPageParam: { page: 1 },
    queryFn: async params => {
      const { page = 1 } = params.pageParam || {};
      try {
        // Merge provided filters with the userId constraint
        const requestFilters = { ...(filters || {}), userId } as Record<string, unknown>;

        const response = await api.get<{ data: WithId<IOrganizationDocument>[]; hasMore: boolean }>(
          '/api/organizations',
          {
            params: {
              query: search,
              filters: requestFilters,
              pagination: {
                page,
                limit: 16,
              },
              orderBy,
            },
          }
        );

        response.data.data.forEach(organization => {
          queryClient.setQueryData(['organizations', organization.id], organization);
        });

        return response.data;
      } catch (e) {
        return { data: [], hasMore: false };
      }
    },
    getNextPageParam: (lastPage, _allPages, { page }) => {
      if (lastPage.hasMore) {
        return { page: page + 1 };
      }
      return undefined;
    },
    enabled: options?.enabled ?? true,
  });
}

/**
 * Hook to search organizations with pagination and filtering
 * Uses standard useQuery with page-based pagination (like admin users tab)
 */
export function useSearchOrganizations(
  params: {
    page: number;
    limit: number;
    search: string;
    filters?: { personal?: boolean };
    orderBy?: { by: 'name' | 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' };
  },
  options?: { enabled?: boolean }
) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['organizations', 'search', params],
    queryFn: async () => {
      try {
        const response = await api.get<{
          data: WithId<IOrganizationDocument>[];
          hasMore: boolean;
          total: number;
        }>('/api/organizations', {
          params: {
            query: params.search,
            filters: params.filters,
            pagination: {
              page: params.page,
              limit: params.limit,
            },
            orderBy: params.orderBy,
          },
        });

        response.data.data.forEach(organization => {
          queryClient.setQueryData(['organizations', organization.id], organization);
        });

        return {
          data: response.data.data,
          totalPages: Math.ceil(response.data.total / params.limit),
          totalOrganizations: response.data.total,
        };
      } catch (e) {
        return { data: [], totalPages: 0, totalOrganizations: 0 };
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 3,
  });
}

/**
 * Hook to get a single organization by ID
 */
export function useGetOrganization(orgId: string | null | undefined) {
  return useQuery({
    queryKey: ['organizations', orgId],
    queryFn: async () => {
      if (!orgId) return null;
      const response = await api.get<WithId<IOrganizationDocument>>(`/api/organizations/${orgId}`);
      return response.data;
    },
    enabled: !!orgId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Hook to create a new organization
 */
export function useCreateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const response = await api.post<WithId<IOrganizationDocument>>('/api/organizations', { name });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Organization created successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to create organization:', error);
      toast.error(`Failed to create organization: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

/**
 * Hook to update an organization
 */
export function useUpdateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, data }: { orgId: string; data: Partial<IOrganizationDocument> }) => {
      const response = await api.put<WithId<IOrganizationDocument>>(`/api/organizations/${orgId}`, data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.setQueryData(['organizations', data.id], data);
      toast.success('Organization updated successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to update organization:', error);
      toast.error(`Failed to update organization: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

/**
 * Hook to delete an organization
 */
export function useDeleteOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      await api.delete(`/api/organizations/${orgId}`);
      return orgId;
    },
    onSuccess: orgId => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.removeQueries({ queryKey: ['organizations', orgId] });
      toast.success('Organization deleted successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to upload an organization logo
 */
export function useUploadOrganizationLogo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      organizationId,
      fileInfo,
      file,
    }: {
      organizationId: string;
      fileInfo: FileGeneratePresignedUrlRequestInputType;
      file: File | Blob;
    }) => {
      // Step 1: Get a presigned URL for the upload
      const { data } = await api.post<
        FileGeneratePresignedUrlResponseType,
        AxiosResponse<FileGeneratePresignedUrlResponseType>,
        FileGeneratePresignedUrlRequestInputType
      >(`/api/organizations/${organizationId}/upload-logo`, fileInfo);

      const { url, fileId } = data;

      // Step 2: Upload the file to the presigned URL
      await axios.put(url, file, {
        headers: {
          'Content-Type': file.type,
        },
      });

      return fileId;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['organizations', variables.organizationId] });
      toast.success('Logo uploaded successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to upload logo:', error);
      toast.error(`Failed to upload logo: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

export function useGetUserOrganizations(userId: string | undefined | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['organizations', 'user', userId],
    queryFn: async () => {
      const { data } = await api.get<{ data: IOrganizationDocument[]; hasMore: boolean; total: number }>(
        '/api/organizations',
        {
          params: {
            filters: { userId },
            pagination: { page: 1, limit: 100 },
            orderBy: { by: 'name', direction: 'asc' },
          },
        }
      );

      data.data.forEach(d => {
        updateAllQueryData(queryClient, 'organizations', 'write', d);
      });

      return data.data;
    },
    enabled: !!userId,
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnMount: false,
  });
}

export function useRemoveMemberFromOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ organizationId, userId }: { organizationId: string; userId: string }) => {
      const organization = await api.delete(`/api/organizations/${organizationId}/members/${userId}`);

      updateAllQueryData(queryClient, 'organizations', 'write', organization.data);

      return organization;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', variables.organizationId] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Member removed successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to remove member:', error);
      toast.error(`Failed to remove member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

export function useLeaveOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ organizationId }: { organizationId: string }) => {
      const organization = await api.delete(`/api/organizations/${organizationId}/members`);

      updateAllQueryData(queryClient, 'organizations', 'write', organization.data);

      return organization;
    },
    onSuccess: () => {
      toast.success('Left organization successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to leave organization:', error);
      toast.error(`Failed to leave organization: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

interface OrganizationSeatsInfo {
  maxSeats: number;
  pendingSeats: number;
  currentSeats: number;
  availableSeats: number;
}

export const useOrganizationSeats = (organizationId?: string): OrganizationSeatsInfo => {
  const { data: organization } = useGetOrganization(organizationId);
  const { data: users } = useGetOrganizationUsers(organizationId);
  const { data: pendingUsers } = useGetPendingOrganizationUsers(organizationId);

  const maxSeats = organization?.seats ?? 0;
  const pendingSeats = pendingUsers?.length ?? 0;
  const currentSeats = (users?.length ?? 0) + pendingSeats;
  const availableSeats = Math.max(0, maxSeats - currentSeats);

  return useMemo(
    () => ({
      maxSeats,
      pendingSeats,
      currentSeats,
      availableSeats,
    }),
    [maxSeats, pendingSeats, currentSeats, availableSeats]
  );
};
