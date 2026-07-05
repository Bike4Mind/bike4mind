/**
 * GitHub Repositories Data Hook
 *
 * Provides React Query hook for fetching accessible GitHub repositories.
 * Used by the Allowed Repositories checklist UI in both Admin and Org settings.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

/**
 * Repository information returned by the API
 */
export interface GitHubRepositoryInfo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
}

/**
 * API response shape
 */
interface GitHubRepositoriesResponse {
  repositories: GitHubRepositoryInfo[];
  hasMore: boolean;
}

/**
 * Query keys for GitHub repositories
 */
export const gitHubRepositoriesQueryKeys = {
  all: ['github-repositories'] as const,
  admin: () => ['github-repositories', 'admin'] as const,
  org: (orgId: string) => ['github-repositories', 'org', orgId] as const,
};

/**
 * Hook to get accessible GitHub repositories for Admin panel
 */
export function useAdminGitHubRepositories(enabled = true) {
  return useQuery({
    queryKey: gitHubRepositoriesQueryKeys.admin(),
    queryFn: async () => {
      const response = await api.get<GitHubRepositoriesResponse>('/api/admin/github/repositories');
      return response.data;
    },
    enabled,
    staleTime: 60000, // 1 minute cache - repo list changes infrequently
    retry: (failureCount, error) => {
      // Don't retry on 404 (no connection configured)
      if ((error as { response?: { status: number } })?.response?.status === 404) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

/**
 * Hook to get accessible GitHub repositories for Organization panel
 */
export function useOrgGitHubRepositories(orgId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: gitHubRepositoriesQueryKeys.org(orgId || ''),
    queryFn: async () => {
      if (!orgId) return null;
      const response = await api.get<GitHubRepositoriesResponse>(`/api/organizations/${orgId}/github/repositories`);
      return response.data;
    },
    enabled: !!orgId && enabled,
    staleTime: 60000, // 1 minute cache - repo list changes infrequently
    retry: (failureCount, error) => {
      // Don't retry on 404 (no connection configured)
      if ((error as { response?: { status: number } })?.response?.status === 404) {
        return false;
      }
      return failureCount < 2;
    },
  });
}
