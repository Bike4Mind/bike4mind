import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

interface GitHubConnectionStatus {
  connected: boolean;
  githubLogin?: string;
  connectedAt?: string;
  lastRotationInitiatedAt?: string | null;
}

export function useGitHubConnectionStatus(userId: string, options?: { enabled?: boolean }) {
  const enabled = (options?.enabled ?? true) && Boolean(userId);
  return useQuery<GitHubConnectionStatus>({
    queryKey: ['github-connection-status', userId],
    queryFn: async () => {
      const { data } = await api.post<GitHubConnectionStatus>('/api/mcp/github/status', { userId });
      return data;
    },
    enabled,
    staleTime: 30_000,
  });
}
