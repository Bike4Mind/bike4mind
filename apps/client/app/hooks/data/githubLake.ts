import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GitHubLakeConnectionStatus, GitHubLakeRepositoryChoicesResponse } from '@bike4mind/common';
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
  lastSyncedCommitSha: string | null;
  /** The latest tree read's split under the sync rules (GitHubLakeTreeCounts); null until a sync read it. */
  candidateCount: number | null;
  skippedCount: number | null;
  /** 'syncing' whose claim went stale (a crashed run): re-syncable, and not worth fast-polling. */
  syncStale: boolean;
  /** Files this connection has ingested into the lake - disconnecting deletes all of them. */
  fileCount: number;
  /** A disconnect was accepted and its file purge is running in the background. */
  disconnecting: boolean;
  /** The pending purge has made no progress for GITHUB_DISCONNECT_STALL_MS, so a retry may re-queue it. */
  disconnectStalled: boolean;
};

export const GITHUB_CONNECTION_ACTIVE_POLL_MS = 4_000;
/** Keeps polling once connected for the same reason as DRIVE_CONNECTION_IDLE_POLL_MS (googleDrive.ts). */
export const GITHUB_CONNECTION_IDLE_POLL_MS = 20_000;

export function gitHubConnectionPollInterval(connection: LakeGitHubConnection | null | undefined): number | false {
  if (!connection) return false;
  const active = connection.disconnecting || (connection.status === 'syncing' && !connection.syncStale);
  return active ? GITHUB_CONNECTION_ACTIVE_POLL_MS : GITHUB_CONNECTION_IDLE_POLL_MS;
}

/**
 * The repository feeding a lake, or null (a personal lake resolves null rather than 404, as Drive's
 * does). `isError` is a genuine failure: missing lake, or a caller with no standing on its org.
 * Every GitHub lake route 403s while EnableDataLakeGitHub is off: a caller that can mount without the
 * flag passes it as `enabled` (LakeSourceConnectActions, LakeGitHubStatusChip); GitHubConnectAction
 * only ever mounts behind it.
 */
export function useLakeGitHubConnection(dataLakeId?: string, enabled = true) {
  const options = useLakeGitHubConnectionOptions(dataLakeId, enabled);
  return useQuery({ ...options, select: response => response.connection });
}

/**
 * Whether the caller may connect, re-sync or disconnect the lake's repository. The status read also
 * admits an appointed org admin, who can see the connection but not operate it, so the controls key
 * off this. Shares useLakeGitHubConnection's query; a payload without the flag reads as `false`, so a dropped field fails closed.
 */
export function useLakeGitHubCanManage(dataLakeId?: string, enabled = true) {
  const options = useLakeGitHubConnectionOptions(dataLakeId, enabled);
  return useQuery({ ...options, select: response => response.canManage === true });
}

type LakeGitHubConnectionResponse = { connection: LakeGitHubConnection | null; canManage: boolean };

function useLakeGitHubConnectionOptions(dataLakeId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  return {
    queryKey: dataLakeKeys.gitHubConnection(dataLakeId),
    enabled: !!dataLakeId && enabled,
    queryFn: async (): Promise<LakeGitHubConnectionResponse> => {
      const response = await api.get<LakeGitHubConnectionResponse>(`/api/data-lakes/${dataLakeId}/github-connection`);
      const next = response.data.connection;
      // A sync ingests in the background, so the lake's file lists and counts only go stale as it
      // lands; refresh them whenever a poll shows the ingested set changed or a sync finished.
      const cached = queryClient.getQueryData<LakeGitHubConnectionResponse>(dataLakeKeys.gitHubConnection(dataLakeId));
      const previous = cached?.connection;
      const syncFinished = previous?.status === 'syncing' && next?.status !== 'syncing';
      // `null` (no connection yet) still counts as a known prior state: a first sync that lands before
      // the first poll after connecting must refresh the file lists too.
      if (dataLakeId && cached !== undefined && (syncFinished || next?.fileCount !== previous?.fileCount)) {
        void invalidateLakeFileQueries(queryClient, dataLakeId);
      }
      return response.data;
    },
    refetchInterval: (query: { state: { data?: LakeGitHubConnectionResponse } }) =>
      enabled ? gitHubConnectionPollInterval(query.state.data?.connection) : false,
  };
}

/** Mint the signed authorize URL for a lake (POST /api/data-lakes/:id/github-connection). */
export function useStartLakeGitHubConnect() {
  return useMutation({
    mutationFn: async (dataLakeId: string) => {
      const response = await api.post<{ authorizeUrl: string }>(`/api/data-lakes/${dataLakeId}/github-connection`);
      return response.data;
    },
  });
}

/**
 * The authorize leg's exchange (POST /api/data-lakes/github-callback): hands GitHub's `code` back
 * with the `state` that minted it, and gets back which lake to reopen the repository picker for.
 * Binds nothing - the server only holds the user's GitHub token for the picker to read.
 */
export function useAuthorizeLakeGitHubConnect() {
  return useMutation({
    mutationFn: async (input: { state: string; code: string }) => {
      const response = await api.post<{ dataLakeId: string }>('/api/data-lakes/github-callback', input);
      return response.data;
    },
  });
}

/**
 * The repository picker's list for one lake's connect flow (GET .../github-connection/repositories),
 * read with the GitHub user token the authorize exchange left held server-side. `retry: false`
 * because a failure here is a 403 (the flow expired) - retrying it cannot succeed. No polling and no
 * refetch-on-focus: the user drives freshness explicitly with the picker's Refresh button.
 */
export function useLakeGitHubRepositoryChoices(dataLakeId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: dataLakeKeys.gitHubRepositoryChoices(dataLakeId),
    enabled: !!dataLakeId && enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const response = await api.get<GitHubLakeRepositoryChoicesResponse>(
        `/api/data-lakes/${dataLakeId}/github-connection/repositories`
      );
      return response.data;
    },
  });
}

/** Bind the repository picked from the list (POST /api/data-lakes/:id/github-connection/complete). */
export function useCompleteLakeGitHubConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { dataLakeId: string; installationId: number; repositoryId: number }) => {
      const { dataLakeId, ...body } = input;
      const response = await api.post<{ connection: LakeGitHubConnection }>(
        `/api/data-lakes/${dataLakeId}/github-connection/complete`,
        body
      );
      return response.data.connection;
    },
    onSuccess: async (_connection, { dataLakeId }) => {
      await queryClient.invalidateQueries({ queryKey: dataLakeKeys.gitHubConnection(dataLakeId) });
      // The picker's list is now stale (the bound repository must show as taken); a closed picker
      // just refetches fresh next time it opens rather than carrying this invalidation forward.
      queryClient.removeQueries({ queryKey: dataLakeKeys.gitHubRepositoryChoices(dataLakeId) });
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
 * Disconnect a lake's repository. The route only queues the purge, so the connection reads back as
 * `disconnecting` until the purge releases it (useLakeGitHubConnection keeps the file lists fresh).
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
