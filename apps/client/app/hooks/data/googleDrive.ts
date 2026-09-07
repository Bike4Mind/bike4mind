import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** Safe, credential-free view returned by GET /api/data-lakes/:id/drive-connection. */
export type LakeDriveConnection = {
  id: string;
  driveFolderId: string;
  folderName: string | null;
  status: 'connected' | 'needs_reconnect' | 'credential_error';
  enabled: boolean;
  lastError: string | null;
  lastUsedAt: string | null;
  connectedAt: string | null;
};

/**
 * User-facing label + severity per connection status. Lives beside the type so every surface that
 * renders a Drive connection (the wizard's connect action, the lake detail panel, the page header)
 * reads the SAME wording - three hand-synced copies would drift the moment a status is added.
 */
export const DRIVE_STATUS_BADGE: Record<
  LakeDriveConnection['status'],
  { label: string; color: 'success' | 'warning' | 'danger' }
> = {
  connected: { label: 'Connected', color: 'success' },
  needs_reconnect: { label: 'Needs reconnect', color: 'warning' },
  credential_error: { label: 'Credential error', color: 'danger' },
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

/** The current Drive connection feeding a lake (null when none). Org owner/manager only, server-side. */
export function useLakeDriveConnection(dataLakeId?: string, enabled = true) {
  return useQuery({
    queryKey: lakeDriveConnectionKey(dataLakeId),
    // `enabled` lets a caller skip a request that cannot succeed: the route resolves the lake's
    // ORGANIZATION, so a personal lake always 404s. Passing false there keeps a guaranteed failure
    // (and its console error) off every personal lake, instead of firing and discarding it.
    enabled: !!dataLakeId && enabled,
    queryFn: async () => {
      const response = await api.get<{ connection: LakeDriveConnection | null }>(
        `/api/data-lakes/${dataLakeId}/drive-connection`
      );
      return response.data.connection;
    },
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

/** Disconnect a lake's Drive folder, releasing the claim (DELETE /api/data-lakes/:id/drive-connection). */
export function useDisconnectLakeDrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dataLakeId: string) => {
      await api.delete(`/api/data-lakes/${dataLakeId}/drive-connection`);
    },
    onSuccess: async (_data, dataLakeId) => {
      await queryClient.invalidateQueries({ queryKey: lakeDriveConnectionKey(dataLakeId) });
    },
  });
}
