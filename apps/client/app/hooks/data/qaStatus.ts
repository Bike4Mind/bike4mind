/**
 * Data hooks for the admin QA status page (`/status`). Read models are
 * type-only imports from server/qa/reads.ts, as in hooks/data/deepAgents.ts.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  QaDiffTest,
  QaFacets,
  QaFlakyRow,
  QaMediaView,
  QaOverview,
  QaRunDetail,
  QaRunDiff,
  QaRunPage,
  QaRunSummary,
  QaSeriesPoint,
  QaTestHistory,
  QaTestView,
  QaTile,
} from '@server/qa/reads';
import { api } from '@client/app/contexts/ApiContext';

export type {
  QaDiffTest,
  QaFacets,
  QaFlakyRow,
  QaMediaView,
  QaOverview,
  QaRunDetail,
  QaRunDiff,
  QaRunPage,
  QaRunSummary,
  QaSeriesPoint,
  QaTestHistory,
  QaTestView,
  QaTile,
};

/** `/status` search params. Server-side twin: parseQaFilters in server/qa/filters.ts. */
export interface QaStatusSearch {
  product?: string;
  tenant?: string;
  env?: string;
  branch?: string;
  range?: '7d' | '30d';
}

export function parseQaStatusSearch(search: Record<string, unknown>): QaStatusSearch {
  const out: QaStatusSearch = {};
  for (const key of ['product', 'tenant', 'env', 'branch'] as const) {
    const value = search[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  if (search.range === '7d' || search.range === '30d') out.range = search.range;
  return out;
}

function filterParams(search: QaStatusSearch): Record<string, string> {
  const params: Record<string, string> = {
    product: search.product ?? '',
    branch: search.branch || 'main',
    range: search.range ?? '7d',
  };
  if (search.tenant) params.tenant = search.tenant;
  if (search.env) params.env = search.env;
  return params;
}

export function useQaFacets(product?: string) {
  return useQuery({
    queryKey: ['qa-facets', product ?? null],
    queryFn: async () => (await api.get<QaFacets>('/api/admin/qa/facets', { params: product ? { product } : {} })).data,
  });
}

export function useQaOverview(search: QaStatusSearch) {
  const params = filterParams(search);
  return useQuery({
    queryKey: ['qa-overview', params],
    enabled: Boolean(search.product),
    refetchInterval: 60_000,
    queryFn: async () => (await api.get<QaOverview>('/api/admin/qa/overview', { params })).data,
  });
}

export function useQaRuns(search: QaStatusSearch) {
  const params = filterParams(search);
  return useInfiniteQuery({
    queryKey: ['qa-runs', params],
    enabled: Boolean(search.product),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<QaRunPage>('/api/admin/qa/runs', {
          params: { ...params, ...(pageParam ? { before: pageParam } : {}) },
        })
      ).data,
    getNextPageParam: last => last.nextBefore,
  });
}

export function useQaRunDetail(id: string | null) {
  return useQuery({
    queryKey: ['qa-run', id],
    enabled: Boolean(id),
    // Signed media URLs and the report token last an hour; refresh well before that.
    staleTime: 10 * 60_000,
    queryFn: async () => (await api.get<QaRunDetail>(`/api/admin/qa/runs/${id}`)).data,
  });
}

/** The key rides as ?testKey= because it contains / > ? and #. */
export function useQaTestHistory(testKey: string | null) {
  return useQuery({
    queryKey: ['qa-test', testKey],
    enabled: Boolean(testKey),
    queryFn: async () => (await api.get<QaTestHistory>('/api/admin/qa/tests', { params: { testKey } })).data,
  });
}
