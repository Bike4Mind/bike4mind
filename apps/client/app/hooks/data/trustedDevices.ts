import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface TrustedDevice {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  /** True for the device this request is coming from. */
  isCurrent: boolean;
}

export const TRUSTED_DEVICES_QUERY_KEY = ['trusted-devices'] as const;

export function useTrustedDevices(enabled = true) {
  return useQuery({
    queryKey: TRUSTED_DEVICES_QUERY_KEY,
    queryFn: async () => {
      const response = await api.get<{ devices: TrustedDevice[] }>('/api/auth/trusted-devices');
      return response.data.devices;
    },
    enabled,
  });
}

export function useRevokeTrustedDevice() {
  const queryClient = useQueryClient();
  return useMutation<{ revoked: boolean; id: string }, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      const response = await api.delete(`/api/auth/trusted-devices/${id}`);
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRUSTED_DEVICES_QUERY_KEY }),
  });
}

export function useRevokeAllTrustedDevices() {
  const queryClient = useQueryClient();
  return useMutation<{ revoked: number }, Error, void>({
    mutationFn: async () => {
      const response = await api.delete('/api/auth/trusted-devices');
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TRUSTED_DEVICES_QUERY_KEY }),
  });
}
