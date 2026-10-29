import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  ADMIN_LEDGER_PAGE_SIZE,
  type AdminCreditSummary,
  type AdminLedgerKind,
  type AdminLedgerPage,
  type AdminRevokeAllApiKeysResponse,
  type AdminRotateApiKeyResponse,
} from '@bike4mind/common';

const userPath = (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}`;
const keyPath = (keyId: string) => `/api/admin/user-api-keys/${encodeURIComponent(keyId)}`;

/** The full credit ledger, newest first, one server page (cursor) at a time. */
export const useAdminCreditLedger = (userId: string, kind: AdminLedgerKind | undefined) =>
  useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'credit-ledger', kind ?? 'all'],
    queryFn: async ({ pageParam }): Promise<AdminLedgerPage> => {
      const params: Record<string, string> = { limit: String(ADMIN_LEDGER_PAGE_SIZE) };
      if (kind) params.kind = kind;
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<AdminLedgerPage>(`${userPath(userId)}/credit-ledger`, { params });
      return response.data;
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
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
  kind: AdminLedgerKind | undefined
): Promise<CreditLedgerExport> => {
  const response = await api.get<Blob>(`${userPath(userId)}/credit-ledger-export`, {
    params: kind ? { kind } : {},
    responseType: 'blob',
  });
  const disposition: unknown = response.headers['content-disposition'];
  const fileName =
    (typeof disposition === 'string' ? disposition.match(/filename="(.+)"/)?.[1] : undefined) ??
    `credits-${userId}-${kind ?? 'all'}.csv`;
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
