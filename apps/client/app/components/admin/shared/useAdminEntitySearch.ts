import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/apiClient';
import { AdminSearchQuerySchema, AdminSearchResponseSchema } from '@client/app/utils/adminEntitySearch';

export type AdminEntitySearchError = 'rateLimited' | 'failed';

function toSearchError(error: unknown): AdminEntitySearchError {
  return isAxiosError(error) && error.response?.status === 429 ? 'rateLimited' : 'failed';
}

export function useAdminEntitySearch(query: string) {
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  const valid = AdminSearchQuerySchema.safeParse({ q: query });
  const ready = valid.success && query.trim() === debouncedQuery;
  const search = useQuery({
    queryKey: ['admin-entity-search', debouncedQuery],
    queryFn: async ({ signal }) =>
      AdminSearchResponseSchema.parse(
        (await api.get('/api/admin/search', { params: { q: debouncedQuery }, signal })).data
      ),
    enabled: ready,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  return {
    results: ready ? (search.data?.results ?? []) : [],
    loading: valid.success && (!ready || search.isFetching),
    error: ready && search.isError ? toSearchError(search.error) : undefined,
    validationError: query.trim().length >= 2 && !valid.success ? valid.error.issues[0]?.message : undefined,
  };
}
