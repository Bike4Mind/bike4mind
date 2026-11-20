import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OrganizationLibraryItem,
  OrganizationLibraryItemSummary,
  OrganizationLibraryKind,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export function useOrganizationLibrary(kind?: OrganizationLibraryKind, organizationId?: string) {
  return useQuery({
    queryKey: ['organization-library', organizationId, kind],
    queryFn: async () => {
      const { data } = await api.get<{ items: OrganizationLibraryItemSummary[] }>(
        organizationId ? `/api/organizations/${organizationId}/library` : '/api/organization-library',
        { params: { kind } }
      );
      return kind ? data.items.filter(item => item.kind === kind) : data.items;
    },
    staleTime: 60_000,
  });
}

export function useReuseLibraryItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const {
        data: { item },
      } = await api.get<{ item: OrganizationLibraryItem }>(`/api/organization-library/${id}`);
      if (item.kind === 'agent') await api.post('/api/agents', item.definition);
      else if (item.kind === 'skill') await api.post('/api/skills', item.definition);
      else if (item.kind === 'prompt') await api.post('/api/briefcase/prompts', item.definition);
      else await api.post('/api/image-templates', item.definition);
    },
    onSuccess: async () => {
      await Promise.all(
        ['agents', 'skills', 'briefcase-catalog', 'image-templates'].map(key =>
          qc.invalidateQueries({ queryKey: [key] })
        )
      );
    },
  });
}
