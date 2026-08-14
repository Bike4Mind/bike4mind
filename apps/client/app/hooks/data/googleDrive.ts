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

export function useDisconnectGoogleDrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.delete('/api/google-drive/disconnect');
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/** The current Drive connection feeding a lake (null when none). Org owner/manager only, server-side. */
export function useLakeDriveConnection(dataLakeId?: string) {
  return useQuery({
    queryKey: lakeDriveConnectionKey(dataLakeId),
    enabled: !!dataLakeId,
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
