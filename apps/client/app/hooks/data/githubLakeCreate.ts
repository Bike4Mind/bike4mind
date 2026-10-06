import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

/**
 * THE ONE PLACE the connector-first GitHub create door is called.
 *
 * Contract (POST /api/data-lakes/github-connect):
 *   { organizationId }  ->  { dataLakeId, authorizeUrl }
 *
 * The route creates a draft, connector-fed org lake under a placeholder name, reuses the caller's
 * own earlier unbound placeholder lake on a retried connect, and mints the authorize URL for the
 * same connect the per-lake door starts. It is deliberately isolated here: if the merged route's
 * shape differs from this, this file is the only edit.
 */
export type BeginGitHubLakeCreateResponse = { dataLakeId: string; authorizeUrl: string };

export const GITHUB_LAKE_CREATE_PATH = '/api/data-lakes/github-connect';

export function useBeginGitHubLakeCreate() {
  return useMutation({
    mutationFn: async (organizationId: string): Promise<BeginGitHubLakeCreateResponse> => {
      const response = await api.post<BeginGitHubLakeCreateResponse>(GITHUB_LAKE_CREATE_PATH, { organizationId });
      return response.data;
    },
  });
}
