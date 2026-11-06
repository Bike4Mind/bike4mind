import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  AdminSubscriptionsFilter,
  AdminSubscriptionsListResponse,
  AdminSubscriptionsSummary,
} from '@client/app/utils/adminSubscriptionsFilter';
import type { SubscriptionsViewCounts } from './subscriptionsListViews';
import { SUBSCRIPTIONS_FILTER_KEYS, type SubscriptionsListParams } from './subscriptionsTabSearch';

const LIST_STALE_MS = 30_000;
const LIST_PATH = '/api/admin/subscriptions';

// Under ['admin', 'subscriptions'] so the grant, remove and credit mutations in hooks/data/subscriptions.ts
// refresh the list too.
export const adminSubscriptionsQueryKey = ['admin', 'subscriptions'] as const;

/** The API filter for the list params: unset filters and empty lists narrow nothing. */
export function toAdminSubscriptionsFilter(params: SubscriptionsListParams): AdminSubscriptionsFilter {
  const set = SUBSCRIPTIONS_FILTER_KEYS.map(key => [key, params[key]] as const).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined
  );
  return {
    ...(Object.fromEntries(set) as AdminSubscriptionsFilter),
    ...(params.search.trim() ? { search: params.search.trim() } : {}),
  };
}

/** The query string GET /api/admin/subscriptions is sent for these params. */
export const adminSubscriptionsListQuery = (params: SubscriptionsListParams) => ({
  ...toAdminSubscriptionsFilter(params),
  page: params.page,
  limit: params.limit,
  sortField: params.sortField,
  sortOrder: params.sortOrder,
});

export function useAdminSubscriptionsList(params: SubscriptionsListParams) {
  const query = adminSubscriptionsListQuery(params);
  return useQuery({
    queryKey: [...adminSubscriptionsQueryKey, 'list', query],
    queryFn: async () => (await api.get<AdminSubscriptionsListResponse>(LIST_PATH, { params: query })).data,
    placeholderData: keepPreviousData,
    staleTime: LIST_STALE_MS,
    refetchOnMount: 'always',
  });
}

export function useAdminSubscriptionsSummary(filter: AdminSubscriptionsFilter, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...adminSubscriptionsQueryKey, 'summary', filter],
    queryFn: async () => (await api.get<AdminSubscriptionsSummary>(`${LIST_PATH}/summary`, { params: filter })).data,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Counts for the view tabs, over every subscription like the users list's tabs. Canceling has no
 * summary view yet, so it is the total of a summary filtered to scheduled cancels.
 */
export function useSubscriptionsViewCounts() {
  const all = useAdminSubscriptionsSummary({});
  const canceling = useAdminSubscriptionsSummary({ cancel: 'scheduled' });
  const data: SubscriptionsViewCounts | undefined =
    all.data && canceling.data && !all.isError && !canceling.isError
      ? { ...all.data.views, all: all.data.total, canceling: canceling.data.total }
      : undefined;
  return {
    data,
    isError: all.isError || canceling.isError,
    refetch: () => {
      void all.refetch();
      void canceling.refetch();
    },
  };
}

// Must match the trailing lines written by pages/api/admin/subscriptions/export.ts.
const EXPORT_TRUNCATED_MARKER = '# Truncated at ';
const EXPORT_SEARCH_TRUNCATED_MARKER = '# Search matched more than';

export type SubscriptionsExport = { blob: Blob; fileName: string; truncated: boolean; searchTruncated: boolean };

/** Downloads the server-capped CSV for the filter; the caller saves the blob. */
export const fetchSubscriptionsExport = async (filter: AdminSubscriptionsFilter): Promise<SubscriptionsExport> => {
  const response = await api.get<Blob>(`${LIST_PATH}/export`, { params: filter, responseType: 'blob' });
  const disposition: unknown = response.headers['content-disposition'];
  const fileName =
    (typeof disposition === 'string' ? disposition.match(/filename="(.+)"/)?.[1] : undefined) ?? 'subscriptions.csv';
  // The server only knows it hit a cap after the body has started, so it says so in the last lines.
  const tail = await response.data.slice(-300).text();
  return {
    blob: response.data,
    fileName,
    truncated: tail.includes(EXPORT_TRUNCATED_MARKER),
    searchTruncated: tail.includes(EXPORT_SEARCH_TRUNCATED_MARKER),
  };
};
