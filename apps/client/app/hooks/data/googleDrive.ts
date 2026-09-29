import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveConnectionStatus } from '@client/app/hooks/data/driveConnectionDisplay';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';

/** Safe, credential-free view returned by GET /api/data-lakes/:id/drive-connection. */
export type LakeDriveConnection = {
  id: string;
  driveFolderId: string;
  folderName: string | null;
  status: DriveConnectionStatus;
  enabled: boolean;
  lastError: string | null;
  lastUsedAt: string | null;
  connectedAt: string | null;
  /** How many documents this connection has ingested into the lake - disconnecting deletes all of them. */
  fileCount: number;
  /** A disconnect was accepted and its file purge is running in the background. */
  disconnecting: boolean;
};

const lakeDriveConnectionKey = (dataLakeId?: string) => ['lake-drive-connection', dataLakeId];

export function useConnectGoogleDrive() {
  return useMutation({
    mutationFn: async () => {
      const response = await api.post<{ authUrl: string }>('/api/google-drive/connect');
      return response.data.authUrl;
    },
    onSuccess: async authUrl => {
      window.location.href = authUrl;
    },
  });
}

/**
 * Disconnect the user's personal Google Drive. Resolves with how many ORG Drive folder syncs were
 * broken by the revoke: the connect flow copies this user's credential, and revoking it at Google
 * kills the whole grant, so the caller must warn that those folders need reconnecting.
 */
export function useDisconnectGoogleDrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await api.delete<{ affectedOrgConnections?: number }>('/api/google-drive/disconnect');
      return response.data?.affectedOrgConnections ?? 0;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      // The lake wizard/panel read connection status from their own query; the revoke just flipped
      // those rows to credential_error server-side, so a cached 'connected' badge would be a lie.
      await queryClient.invalidateQueries({ queryKey: ['lake-drive-connection'] });
    },
  });
}

/** Fast cadence while a connection's ingest is actively in flight. */
export const DRIVE_CONNECTION_ACTIVE_POLL_MS = 4_000;

/**
 * Never stops polling once a connection exists: a fresh connect writes `status: 'connected'`
 * immediately (see drive-sync.ts), before the queued ingest job claims it into 'syncing' moments
 * later (OrgGoogleDriveConnectionModel.claimForSync) and releases it back to 'connected' when
 * done. A single settled read landing in that pre-claim gap would otherwise cache `fileCount: 0`
 * forever, since nothing else invalidates this query once the component stops remounting - this
 * idle cadence is what eventually catches the real, post-ingest count.
 */
export const DRIVE_CONNECTION_IDLE_POLL_MS = 20_000;

/** Exported so the interval logic is unit-testable without mounting the query. */
export function driveConnectionPollInterval(connection: LakeDriveConnection | null | undefined): number | false {
  if (!connection) return false;
  return connection.status === 'syncing' || connection.disconnecting
    ? DRIVE_CONNECTION_ACTIVE_POLL_MS
    : DRIVE_CONNECTION_IDLE_POLL_MS;
}

/**
 * The current Drive connection feeding a lake (null when none, including a personal lake - the
 * route resolves 200 with a null connection for those rather than 404). `isError` is therefore a
 * genuine failure: the lake doesn't exist, or the caller lacks org owner/manager access.
 */
export function useLakeDriveConnection(dataLakeId?: string, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: lakeDriveConnectionKey(dataLakeId),
    // `enabled` lets a caller skip a request it already knows the answer to: a lake with no
    // `organizationId` always resolves `connection: null`, so a caller that already has that field
    // can skip the round trip entirely rather than firing it for a known answer.
    enabled: !!dataLakeId && enabled,
    queryFn: async () => {
      const response = await api.get<{ connection: LakeDriveConnection | null }>(
        `/api/data-lakes/${dataLakeId}/drive-connection`
      );
      const next = response.data.connection;
      // The purge runs in the background after a disconnect, so the lake's file lists only go
      // stale as it progresses; refresh them whenever a disconnecting read shows files removed.
      const previous = queryClient.getQueryData<LakeDriveConnection | null>(lakeDriveConnectionKey(dataLakeId));
      if (dataLakeId && previous?.disconnecting && (!next || next.fileCount !== previous.fileCount)) {
        void invalidateLakeFileQueries(queryClient, dataLakeId);
      }
      return next;
    },
    refetchInterval: query => (enabled ? driveConnectionPollInterval(query.state.data) : false),
  });
}

/** Connect a Drive folder to a lake and enqueue ingest (POST /api/data-lakes/drive-sync). */
export function useConnectDriveFolderToLake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { dataLakeId: string; driveFolderId: string; folderName?: string }) => {
      const response = await api.post<{ connectionId: string; status: string }>('/api/data-lakes/drive-sync', input);
      return response.data;
    },
    onSuccess: async (_data, { dataLakeId }) => {
      await queryClient.invalidateQueries({ queryKey: lakeDriveConnectionKey(dataLakeId) });
    },
  });
}

function invalidateLakeFileQueries(queryClient: ReturnType<typeof useQueryClient>, dataLakeId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) }),
    queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot }),
  ]);
}

/**
 * Disconnect a lake's Drive folder (DELETE /api/data-lakes/:id/drive-connection). The route only
 * queues the purge of every FabFile the connection ingested; the connection then reads
 * `disconnecting` until the background purge releases it, and useLakeDriveConnection refreshes
 * the lake's file/count queries as that purge removes files.
 */
export function useDisconnectLakeDrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dataLakeId: string) => {
      await api.delete(`/api/data-lakes/${dataLakeId}/drive-connection`);
    },
    onSuccess: async (_data, dataLakeId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: lakeDriveConnectionKey(dataLakeId) }),
        invalidateLakeFileQueries(queryClient, dataLakeId),
      ]);
    },
  });
}
