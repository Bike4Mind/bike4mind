/**
 * Organization GitHub Connection Data Hooks
 *
 * Provides React Query hooks for managing organization-level GitHub API connections.
 * Used in the organization settings UI for configuring GitHub App or PAT connections.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IOrgGitHubConnectionResponse, ITestConnectionResult } from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

/**
 * Request types for creating/updating connections
 */
export interface CreateGitHubAppConnectionRequest {
  connectionType: 'github_app';
  appId: string;
  installationId: string;
  privateKey: string;
  allowedRepositories?: string[];
}

export interface CreateGitHubPATConnectionRequest {
  connectionType: 'service_account';
  accessToken: string;
  patExpiresAt?: string;
  allowedRepositories?: string[];
}

export type CreateGitHubConnectionRequest = CreateGitHubAppConnectionRequest | CreateGitHubPATConnectionRequest;

export interface UpdateGitHubConnectionRequest {
  allowedRepositories?: string[];
  enabled?: boolean;
}

export interface RotateKeyRequest {
  privateKey: string;
}

export interface RotatePATRequest {
  accessToken: string;
  patExpiresAt?: string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: string;
  usagePercent: number;
  isNearLimit: boolean;
}

/**
 * Query keys for organization GitHub connection
 */
export const orgGitHubConnectionQueryKeys = {
  all: ['org-github-connection'] as const,
  connection: (orgId: string) => ['org-github-connection', orgId, 'connection'] as const,
  rateLimit: (orgId: string) => ['org-github-connection', orgId, 'rate-limit'] as const,
};

/**
 * Hook to get organization GitHub connection status
 */
export function useGetOrgGitHubConnection(orgId: string | null | undefined) {
  return useQuery({
    queryKey: orgGitHubConnectionQueryKeys.connection(orgId || ''),
    queryFn: async () => {
      if (!orgId) return null;
      const response = await api.get<{ connected: boolean; connection?: IOrgGitHubConnectionResponse }>(
        `/api/organizations/${orgId}/github/connection`
      );
      return response.data;
    },
    enabled: !!orgId,
    retry: (failureCount, error) => {
      // Don't retry on 404 (connection doesn't exist)
      if ((error as { response?: { status: number } })?.response?.status === 404) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

/**
 * Hook to create organization GitHub connection
 */
export function useCreateOrgGitHubConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, data }: { orgId: string; data: CreateGitHubConnectionRequest }) => {
      const response = await api.post<IOrgGitHubConnectionResponse>(
        `/api/organizations/${orgId}/github/connection`,
        data
      );
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: orgGitHubConnectionQueryKeys.all });
      queryClient.setQueryData(orgGitHubConnectionQueryKeys.connection(data.organizationId || ''), {
        connected: true,
        connection: data,
      });
      toast.success('GitHub connection created successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to update organization GitHub connection
 */
export function useUpdateOrgGitHubConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, data }: { orgId: string; data: UpdateGitHubConnectionRequest }) => {
      const response = await api.put<{ connection: IOrgGitHubConnectionResponse }>(
        `/api/organizations/${orgId}/github/connection`,
        data
      );
      return { orgId, connection: response.data.connection };
    },
    onSuccess: ({ orgId, connection }) => {
      queryClient.invalidateQueries({ queryKey: orgGitHubConnectionQueryKeys.connection(orgId) });
      queryClient.setQueryData(orgGitHubConnectionQueryKeys.connection(orgId), {
        connected: true,
        connection,
      });
      toast.success('GitHub connection updated successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to delete organization GitHub connection
 */
export function useDeleteOrgGitHubConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      await api.delete(`/api/organizations/${orgId}/github/connection`);
      return orgId;
    },
    onSuccess: orgId => {
      queryClient.invalidateQueries({ queryKey: orgGitHubConnectionQueryKeys.all });
      queryClient.setQueryData(orgGitHubConnectionQueryKeys.connection(orgId), { connected: false });
      toast.success('GitHub connection deleted successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to test organization GitHub connection
 */
export function useTestOrgGitHubConnection() {
  return useMutation({
    mutationFn: async (orgId: string) => {
      const response = await api.post<ITestConnectionResult>(`/api/organizations/${orgId}/github/test`);
      return response.data;
    },
    onSuccess: data => {
      if (data.success) {
        const successData = data as { success: true; type: string; login: string; latencyMs: number };
        toast.success(
          `Connection successful! Authenticated as ${successData.type === 'app' ? 'GitHub App' : 'user'}: ${successData.login} (${data.latencyMs}ms)`
        );
      } else {
        const failData = data as { success: false; error: string };
        toast.error(`Connection test failed: ${failData.error}`);
      }
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to get organization GitHub rate limit status
 */
export function useGetOrgGitHubRateLimit(orgId: string | null | undefined, enabled = false) {
  return useQuery({
    queryKey: orgGitHubConnectionQueryKeys.rateLimit(orgId || ''),
    queryFn: async () => {
      if (!orgId) return null;
      const response = await api.get<{ rateLimit: RateLimitInfo }>(`/api/organizations/${orgId}/github/rate-limit`);
      return response.data.rateLimit;
    },
    enabled: !!orgId && enabled,
    staleTime: 30000, // Consider rate limit data stale after 30 seconds
    retry: false,
  });
}

/**
 * Hook to rotate organization GitHub App private key
 */
export function useRotateOrgGitHubKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, data }: { orgId: string; data: RotateKeyRequest }) => {
      const response = await api.post<{ success: boolean; message: string }>(
        `/api/organizations/${orgId}/github/rotate-key`,
        data
      );
      return { orgId, ...response.data };
    },
    onSuccess: ({ orgId }) => {
      queryClient.invalidateQueries({ queryKey: orgGitHubConnectionQueryKeys.connection(orgId) });
      toast.success('Private key rotated successfully. Cached tokens have been cleared.');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to rotate organization GitHub PAT
 */
export function useRotateOrgGitHubPAT() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, data }: { orgId: string; data: RotatePATRequest }) => {
      const response = await api.post<{ success: boolean; message: string }>(
        `/api/organizations/${orgId}/github/rotate-pat`,
        data
      );
      return { orgId, ...response.data };
    },
    onSuccess: ({ orgId }) => {
      queryClient.invalidateQueries({ queryKey: orgGitHubConnectionQueryKeys.connection(orgId) });
      toast.success('Personal Access Token rotated successfully.');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
