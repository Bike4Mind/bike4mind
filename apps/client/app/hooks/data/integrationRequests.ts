import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationId } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';

/** GET /api/integrations/requests: roadmap demand, and which entries the caller asked for. */
export interface IntegrationRequestSummary {
  counts: Partial<Record<IntegrationId, number>>;
  mine: IntegrationId[];
}

export const integrationRequestKeys = {
  all: ['integration-requests'] as const,
};

export function useIntegrationRequests() {
  return useQuery({
    queryKey: integrationRequestKeys.all,
    queryFn: async (): Promise<IntegrationRequestSummary> => {
      const { data } = await api.get<IntegrationRequestSummary>('/api/integrations/requests');
      return data;
    },
    staleTime: 60_000,
  });
}

/**
 * File or withdraw the caller's request for a roadmap entry. Optimistic, so the button flips
 * and the count moves on click; a failure rolls both back.
 */
export function useToggleIntegrationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ integrationId, requested }: { integrationId: IntegrationId; requested: boolean }) => {
      if (requested) {
        await api.delete('/api/integrations/requests', { params: { integrationId } });
      } else {
        await api.post('/api/integrations/requests', { integrationId });
      }
    },
    onMutate: async ({ integrationId, requested }) => {
      await queryClient.cancelQueries({ queryKey: integrationRequestKeys.all });
      const previous = queryClient.getQueryData<IntegrationRequestSummary>(integrationRequestKeys.all);
      const base: IntegrationRequestSummary = previous ?? { counts: {}, mine: [] };
      const count = base.counts[integrationId] ?? 0;
      queryClient.setQueryData<IntegrationRequestSummary>(integrationRequestKeys.all, {
        counts: { ...base.counts, [integrationId]: Math.max(0, count + (requested ? -1 : 1)) },
        mine: requested ? base.mine.filter(id => id !== integrationId) : [...base.mine, integrationId],
      });
      return { previous };
    },
    onError: (_error, { requested }, context) => {
      queryClient.setQueryData(integrationRequestKeys.all, context?.previous);
      toast.error(requested ? "Couldn't withdraw your request. Try again." : "Couldn't send your request. Try again.");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationRequestKeys.all }),
  });
}
