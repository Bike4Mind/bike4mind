import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  AdminPaymentsFilter,
  AdminPaymentsListResponse,
  AdminPaymentsSummaryResponse,
} from '@bike4mind/server-utils/app/utils/adminPayments';

export const ADMIN_PAYMENTS_PATH = '/api/admin/payments';
export const ADMIN_PAYMENTS_SUMMARY_PATH = `${ADMIN_PAYMENTS_PATH}/summary`;
export const ADMIN_PAYMENTS_EXPORT_PATH = `${ADMIN_PAYMENTS_PATH}/export`;

export type AdminPaymentsListQuery = AdminPaymentsFilter & { page: number; limit: number };

export function useAdminPaymentsSummary(filter: AdminPaymentsFilter, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['admin', 'payments', 'summary', filter],
    queryFn: async () =>
      (await api.get<AdminPaymentsSummaryResponse>(ADMIN_PAYMENTS_SUMMARY_PATH, { params: filter })).data,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useAdminPaymentsList(query: AdminPaymentsListQuery, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['admin', 'payments', 'list', query],
    queryFn: async () => (await api.get<AdminPaymentsListResponse>(ADMIN_PAYMENTS_PATH, { params: query })).data,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Read from the export's `X-Export-Notes` header (pages/api/admin/payments/export.ts). */
export type PaymentsExport = { blob: Blob; fileName: string; truncated: boolean; searchTruncated: boolean };

export async function fetchPaymentsExport(filter: AdminPaymentsFilter): Promise<PaymentsExport> {
  const response = await api.get<Blob>(ADMIN_PAYMENTS_EXPORT_PATH, { params: filter, responseType: 'blob' });
  const disposition: unknown = response.headers?.['content-disposition'];
  const fileName =
    (typeof disposition === 'string' ? disposition.match(/filename="(.+)"/)?.[1] : undefined) ??
    `payments-${filter.from ?? 'range'}-to-${filter.to ?? 'today'}.csv`;
  const notesHeader: unknown = response.headers?.['x-export-notes'];
  const notes = typeof notesHeader === 'string' ? notesHeader.split(',') : [];
  return {
    blob: response.data,
    fileName,
    truncated: notes.includes('truncated'),
    searchTruncated: notes.includes('search_truncated'),
  };
}
