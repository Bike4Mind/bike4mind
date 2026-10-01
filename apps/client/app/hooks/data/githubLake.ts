import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GitHubLakeConnectionStatus } from '@bike4mind/common';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import { invalidateLakeFileQueries } from '@client/app/hooks/data/invalidateLakeFileQueries';

/**
 * Wire shape of GET /api/data-lakes/:id/github-connection - IOrgGitHubLakeConnectionResponse with
 * its dates serialized. Must stay in sync with toGitHubLakeConnectionResponse (githubLakeConnection.ts).
 */
export type LakeGitHubConnection = {
  id: string;
  accountLogin: string;
  repositoryId: number;
  repositoryFullName: string;
  connectedBy: string;
  connectedAt: string;
  enabled: boolean;
  status: GitHubLakeConnectionStatus;
  lastError: string | null;
  defaultBranch: string | null;
  lastSyncedAt: string | null;
  /** 'syncing' whose claim went stale (a crashed run): re-syncable, and not worth fast-polling. */
  syncStale: boolean;
  /** Files this connection has ingested into the lake - disconnecting deletes all of them. */
  fileCount: number;
};

export type GitHubLakeConnectUrls = { installUrl: string; authorizeUrl: string };

export const GITHUB_CONNECTION_ACTIVE_POLL_MS = 4_000;
/** Keeps polling once connected for the same reason as DRIVE_CONNECTION_IDLE_POLL_MS (googleDrive.ts). */
export const GITHUB_CONNECTION_IDLE_POLL_MS = 20_000;

export function gitHubConnectionPollInterval(connection: LakeGitHubConnection | null | undefined): number | false {
  if (!connection) return false;
  return connection.status === 'syncing' && !connection.syncStale
    ? GITHUB_CONNECTION_ACTIVE_POLL_MS
    : GITHUB_CONNECTION_IDLE_POLL_MS;
}

/**
 * The repository feeding a lake, or null (a personal lake resolves null rather than 404, as Drive's
 * does). `isError` is a genuine failure: missing lake, or a caller who is not an org owner/manager.
 * Every GitHub lake route 403s while EnableDataLakeGitHub is off: a caller that can mount without the
 * flag passes it as `enabled` (LakeSourceConnectActions, LakeGitHubStatusChip); GitHubConnectAction
 * only ever mounts behind it.
 */
export function useLakeGitHubConnection(dataLakeId?: string, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: dataLakeKeys.gitHubConnection(dataLakeId),
    enabled: !!dataLakeId && enabled,
    queryFn: async () => {
      const response = await api.get<{ connection: LakeGitHubConnection | null }>(
        `/api/data-lakes/${dataLakeId}/github-connection`
      );
      const next = response.data.connection;
      // A sync ingests in the background, so the lake's file lists and counts only go stale as it
      // lands; refresh them whenever a poll shows the ingested set changed or a sync finished.
      const previous = queryClient.getQueryData<LakeGitHubConnection | null>(dataLakeKeys.gitHubConnection(dataLakeId));
      const syncFinished = previous?.status === 'syncing' && next?.status !== 'syncing';
      if (dataLakeId && previous && (syncFinished || next?.fileCount !== previous.fileCount)) {
        void invalidateLakeFileQueries(queryClient, dataLakeId);
      }
      return next;
    },
    refetchInterval: query => (enabled ? gitHubConnectionPollInterval(query.state.data) : false),
  });
}

/** Mint the signed install/authorize URLs for a lake (POST /api/data-lakes/:id/github-connection). */
export function useStartLakeGitHubConnect() {
  return useMutation({
    mutationFn: async (dataLakeId: string) => {
      const response = await api.post<GitHubLakeConnectUrls>(`/api/data-lakes/${dataLakeId}/github-connection`);
      return response.data;
    },
  });
}

/** Bind the installed repository to the lake signed into `state` (POST /api/data-lakes/github-callback). */
export function useCompleteLakeGitHubConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { state: string; code: string; installationId: number }) => {
      const response = await api.post<{ connection: LakeGitHubConnection }>('/api/data-lakes/github-callback', input);
      return response.data.connection;
    },
    onSuccess: async () => {
      // The lake id lives only inside the signed state, so refresh every lake's connection read.
      await queryClient.invalidateQueries({ queryKey: dataLakeKeys.gitHubConnectionRoot });
    },
  });
}

/** Queue a manual re-sync (POST /api/data-lakes/:id/github-connection/sync, 202). */
export function useResyncLakeGitHub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dataLakeId: string) => {
      await api.post(`/api/data-lakes/${dataLakeId}/github-connection/sync`);
    },
    onSuccess: async (_data, dataLakeId) => {
      await queryClient.invalidateQueries({ queryKey: dataLakeKeys.gitHubConnection(dataLakeId) });
    },
  });
}

/**
 * Disconnect a lake's repository. The route purges every file the connection ingested before it
 * answers, so the lake's file/count queries go stale along with the connection itself.
 */
export function useDisconnectLakeGitHub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dataLakeId: string) => {
      await api.delete(`/api/data-lakes/${dataLakeId}/github-connection`);
    },
    onSuccess: async (_data, dataLakeId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.gitHubConnection(dataLakeId) }),
        invalidateLakeFileQueries(queryClient, dataLakeId),
      ]);
    },
  });
}
