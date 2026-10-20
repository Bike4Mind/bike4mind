import { OrganizationStorageUsage } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';

export const orgStorageUsageQueryKey = (orgId: string) => ['organizations', orgId, 'storage-usage'] as const;

/** The org's storage pool and its uploaders (GET /api/organizations/:id/storage-usage, org admins only). */
export function useOrgStorageUsage(orgId: string | null | undefined) {
  return useQuery({
    queryKey: orgStorageUsageQueryKey(orgId ?? ''),
    queryFn: async () => {
      const { data } = await api.get<OrganizationStorageUsage>(`/api/organizations/${orgId}/storage-usage`);
      return data;
    },
    enabled: !!orgId,
  });
}
