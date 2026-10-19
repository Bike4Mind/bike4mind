import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Prefix shared by every toggle mutation; `isMutating` on it counts the toggles in flight for any entry. */
const TOGGLE_MUTATION_KEY = ['integration-requests', 'toggle'] as const;

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

/** The summary after the caller's request for `integrationId` is filed (`requested` true) or withdrawn (false). */
function withRequest(
  summary: IntegrationRequestSummary | undefined,
  integrationId: IntegrationId,
  requested: boolean
): IntegrationRequestSummary {
  const base = summary ?? { counts: {}, mine: [] };
  const others = base.mine.filter(id => id !== integrationId);
  const count = base.counts[integrationId] ?? 0;
  return {
    counts: { ...base.counts, [integrationId]: Math.max(0, count + (requested ? 1 : -1)) },
    mine: requested ? [...others, integrationId] : others,
  };
}

/**
 * File or withdraw the caller's request for one roadmap entry. Optimistic, so the button flips
 * and the count moves on click. Toggles for the same entry run one after another (a mutation
 * scope), and `isPending` reads true for every button of that entry, so a double-click cannot
 * race a POST against a DELETE.
 *
 * A failure undoes only its own change rather than restoring a snapshot, so it cannot clobber
 * an optimistic update another click made meanwhile. The server copy is re-read once the last
 * toggle in flight settles, never while another is still pending.
 */
export function useToggleIntegrationRequest(integrationId: IntegrationId) {
  const queryClient = useQueryClient();
  const mutationKey = [...TOGGLE_MUTATION_KEY, integrationId];
  const mutation = useMutation({
    mutationKey,
    scope: { id: `integration-request-${integrationId}` },
    mutationFn: async ({ requested }: { requested: boolean }) => {
      if (requested) {
        await api.delete('/api/integrations/requests', { params: { integrationId } });
      } else {
        await api.post('/api/integrations/requests', { integrationId });
      }
    },
    onMutate: async ({ requested }) => {
      await queryClient.cancelQueries({ queryKey: integrationRequestKeys.all });
      queryClient.setQueryData<IntegrationRequestSummary>(integrationRequestKeys.all, current =>
        withRequest(current, integrationId, !requested)
      );
    },
    onError: (_error, { requested }) => {
      queryClient.setQueryData<IntegrationRequestSummary>(integrationRequestKeys.all, current =>
        current ? withRequest(current, integrationId, requested) : current
      );
      toast.error(requested ? "Couldn't withdraw your request. Try again." : "Couldn't send your request. Try again.");
    },
    onSettled: () => {
      // This mutation still counts as in flight here; any more than that means another toggle
      // is pending, and a refetch now would overwrite its optimistic state with the old server copy.
      if (queryClient.isMutating({ mutationKey: TOGGLE_MUTATION_KEY }) > 1) return;
      return queryClient.invalidateQueries({ queryKey: integrationRequestKeys.all });
    },
  });
  const isPending = useIsMutating({ mutationKey }) > 0;
  return { toggle: mutation.mutate, isPending };
}
