import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { IAdminLegacyApiKeys } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export type AdminLegacyApiKeysParams = { page: number; limit: number; days: number };

/** GET /api/admin/api-keys/legacy: one server page of recently used legacy keys. */
export const useAdminLegacyApiKeys = (params: AdminLegacyApiKeysParams) =>
  useQuery({
    queryKey: ['admin', 'api-keys', 'legacy', params],
    queryFn: async () => {
      const response = await api.get<IAdminLegacyApiKeys>('/api/admin/api-keys/legacy', { params });
      return response.data;
    },
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
