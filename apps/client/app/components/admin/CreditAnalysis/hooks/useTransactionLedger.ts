import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { IAdminLedgerResponse, CreditTransactionType, CompletionSource } from '@bike4mind/common';

export interface LedgerFilters {
  days?: number;
  /** 'all' clears the type filter. */
  type?: CreditTransactionType | 'all';
  /** 'all' clears the source filter. */
  source?: CompletionSource | 'all';
  model?: string;
}

/**
 * One filtered, paginated page of an organization's credit-transaction ledger.
 * Admin-gated; disabled until an org is selected. Keeps the previous page while
 * fetching the next so paging/filtering doesn't flash empty.
 */
export const useTransactionLedger = (
  organizationId: string | null,
  filters: LedgerFilters,
  page: number,
  limit: number
) => {
  const isAdmin = useUser(s => s.isAdmin);

  return useQuery({
    queryKey: ['admin-ledger', organizationId, filters, page, limit],
    queryFn: async () => {
      const params: Record<string, string | number> = { organizationId: organizationId!, page, limit };
      if (filters.days) params.days = filters.days;
      if (filters.type && filters.type !== 'all') params.type = filters.type;
      if (filters.source && filters.source !== 'all') params.source = filters.source;
      if (filters.model) params.model = filters.model;
      const { data } = await api.get<IAdminLedgerResponse>('/api/admin/transactions', { params });
      return data;
    },
    enabled: isAdmin && !!organizationId,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60,
  });
};
