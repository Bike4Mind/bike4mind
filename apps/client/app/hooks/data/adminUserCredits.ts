import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  ADMIN_LEDGER_PAGE_SIZE,
  type AdminCreditSummary,
  type AdminLedgerFilter,
  type AdminLedgerPage,
  type AdminRevokeAllApiKeysResponse,
  type AdminRotateApiKeyResponse,
} from '@bike4mind/common';

const userPath = (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}`;
const keyPath = (keyId: string) => `/api/admin/user-api-keys/${encodeURIComponent(keyId)}`;

/** The filter as query params; unset fields are left out. */
const filterParams = (filter: AdminLedgerFilter): Record<string, string> =>
  Object.fromEntries(Object.entries(filter).filter((entry): entry is [string, string] => !!entry[1]));

/**
 * The credit ledger under `filter`, newest first, one server page (cursor) at a time. `enabled: false`
 * holds the query while the filter is not one the server would accept (e.g. a reversed date range).
 */
export const useAdminCreditLedger = (userId: string, filter: AdminLedgerFilter, { enabled = true } = {}) =>
  useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'credit-ledger', filterParams(filter)],
    queryFn: async ({ pageParam }): Promise<AdminLedgerPage> => {
      const params: Record<string, string> = { ...filterParams(filter), limit: String(ADMIN_LEDGER_PAGE_SIZE) };
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<AdminLedgerPage>(`${userPath(userId)}/credit-ledger`, { params });
      return response.data;
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
    enabled,
  });

export const useAdminCreditSummary = (userId: string) =>
  useQuery({
    queryKey: ['admin', 'users', userId, 'credit-summary'],
    queryFn: async (): Promise<AdminCreditSummary> => {
      const response = await api.get<AdminCreditSummary>(`${userPath(userId)}/credit-summary`);
      return response.data;
    },
    staleTime: 1000 * 60,
  });

/** Must match the trailing line written by pages/api/admin/users/[userId]/credit-ledger-export.ts. */
const EXPORT_TRUNCATED_MARKER = '# Truncated at ';

export type CreditLedgerExport = { blob: Blob; fileName: string; truncated: boolean };

/** Downloads the server-capped CSV for the given filter; the caller saves the blob. */
export const fetchCreditLedgerExport = async (
  userId: string,
  filter: AdminLedgerFilter
): Promise<CreditLedgerExport> => {
  const response = await api.get<Blob>(`${userPath(userId)}/credit-ledger-export`, {
    params: filterParams(filter),
    responseType: 'blob',
  });
  const disposition: unknown = response.headers['content-disposition'];
  // Mirrors the name credit-ledger-export.ts sets, minus the day, for when the header is unreadable.
  const narrowed = filter.model || filter.source || filter.from || filter.to ? '-filtered' : '';
  const fileName =
    (typeof disposition === 'string' ? disposition.match(/filename="(.+)"/)?.[1] : undefined) ??
    `credits-${userId}-${filter.kind ?? 'all'}${narrowed}.csv`;
  // The server only knows it hit the cap after the body has started, so it marks that with a final line.
  const truncated = (await response.data.slice(-200).text()).includes(EXPORT_TRUNCATED_MARKER);
  return { blob: response.data, fileName, truncated };
};

/** Every query a key write can change: the key list, and the profile's activity and admin log. */
const useInvalidateUserKeys = (userId: string) => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-api-keys', userId] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
    ]);
};

type KeyWrite = { keyId: string; reason: string };

export const useAdminRevokeApiKey = (userId: string) => {
  const invalidate = useInvalidateUserKeys(userId);
  return useMutation({
    mutationFn: async ({ keyId, reason }: KeyWrite) => {
      await api.post(`${keyPath(keyId)}/revoke`, { reason });
    },
    onSettled: invalidate,
  });
};

export const useAdminRestoreApiKey = (userId: string) => {
  const invalidate = useInvalidateUserKeys(userId);
  return useMutation({
    mutationFn: async ({ keyId, reason }: KeyWrite) => {
      await api.post(`${keyPath(keyId)}/restore`, { reason });
    },
    onSettled: invalidate,
  });
};

export const useAdminRotateApiKey = (userId: string) => {
  const invalidate = useInvalidateUserKeys(userId);
  return useMutation({
    mutationFn: async ({ keyId, reason }: KeyWrite): Promise<AdminRotateApiKeyResponse> => {
      const response = await api.post<AdminRotateApiKeyResponse>(`${keyPath(keyId)}/rotate`, { reason });
      return response.data;
    },
    onSettled: invalidate,
  });
};

export const useAdminRevokeAllApiKeys = (userId: string) => {
  const invalidate = useInvalidateUserKeys(userId);
  return useMutation({
    mutationFn: async (reason: string): Promise<AdminRevokeAllApiKeysResponse> => {
      const response = await api.post<AdminRevokeAllApiKeysResponse>(`${userPath(userId)}/revoke-api-keys`, {
        reason,
      });
      return response.data;
    },
    onSettled: invalidate,
  });
};
