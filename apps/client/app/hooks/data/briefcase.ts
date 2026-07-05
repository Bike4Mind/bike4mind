import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IPromptBatchQuery,
  IPromptCatalog,
  IBriefcasePromptDocument,
  BriefcasePromptInputType,
  BriefcasePromptUpdateInputType,
} from '@bike4mind/common';

const CATALOG_KEY = 'briefcase-catalog';

/**
 * Canonicalize the query set so launchers that pass the same logical queries in
 * any order coalesce onto ONE cached request. Without this, object identity /
 * ordering differences silently defeat coalescing (react-query keys by value).
 *
 * KEEP IN SYNC with IPromptBatchQuery: every selector field must be normalized
 * here, or two queries differing only in a new field would collide on one cache
 * entry (wrong catalog) or fail to coalesce.
 */
function canonicalKey(queries: IPromptBatchQuery[]): string {
  const normalized = queries
    .map(q => ({ key: q.key, type: q.type ?? null, personal: q.personal ?? false, tags: [...(q.tags ?? [])].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return JSON.stringify(normalized);
}

/**
 * Batched, coalesced catalog fetch. All launchers subscribing with the same
 * logical queries share one request. All-or-nothing on the server; a transient
 * failure self-heals via bounded backoff rather than wedging the panel.
 */
export function useBriefcaseCatalog(queries: IPromptBatchQuery[], enabled = true) {
  return useQuery({
    queryKey: [CATALOG_KEY, canonicalKey(queries)],
    queryFn: async () => {
      const { data } = await api.post<{ catalog: IPromptCatalog }>('/api/briefcase/catalog', { queries });
      return data.catalog;
    },
    enabled: enabled && queries.length > 0,
    staleTime: 10 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    // Recover the whole panel after a transient all-or-nothing failure without
    // needing a mutation to invalidate the cache.
    refetchOnReconnect: true,
    retry: 2,
    retryDelay: attempt => Math.min(1000 * 2 ** attempt, 8000),
  });
}

/** Authoritative click-time refetch: the full prompt (incl. promptText) by id. */
export async function fetchPromptById(id: string): Promise<IBriefcasePromptDocument> {
  const { data } = await api.get<{ prompt: IBriefcasePromptDocument }>(`/api/briefcase/prompts/${id}`);
  return data.prompt;
}

export function useCreatePersonalPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BriefcasePromptInputType) => {
      const { data } = await api.post<{ prompt: IBriefcasePromptDocument }>('/api/briefcase/prompts', input);
      return data.prompt;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [CATALOG_KEY] }),
  });
}

export function useUpdatePersonalPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: BriefcasePromptUpdateInputType & { id: string }) => {
      const { data } = await api.put<{ prompt: IBriefcasePromptDocument }>(`/api/briefcase/prompts/${id}`, patch);
      return data.prompt;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [CATALOG_KEY] }),
  });
}

export function useDeletePersonalPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/briefcase/prompts/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [CATALOG_KEY] }),
  });
}
