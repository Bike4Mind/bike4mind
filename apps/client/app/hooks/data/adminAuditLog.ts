import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AuditEntry, AuditLogFilters, AuditLogPage, AuditSummary, AuditSummaryWindow } from '@bike4mind/common';
import { downloadData } from '@client/app/utils/download';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_EXPORT_FILENAME = 'audit-log.csv';

/** JSON carries `occurredAt` as an ISO string; consumers expect the real `AuditEntry` Date. */
type WireAuditEntry = Omit<AuditEntry, 'occurredAt'> & { occurredAt: string | Date };

const reviveAuditEntry = (entry: WireAuditEntry): AuditEntry => ({ ...entry, occurredAt: new Date(entry.occurredAt) });

const definedFilterParams = (filters: AuditLogFilters): Record<string, string> =>
  Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as Record<string, string>;

export const useAuditLog = (filters: AuditLogFilters, options: { enabled?: boolean; limit?: number } = {}) => {
  const { enabled = true, limit = DEFAULT_PAGE_SIZE } = options;
  return useInfiniteQuery({
    queryKey: ['admin', 'audit-log', 'list', filters],
    queryFn: async ({ pageParam }): Promise<AuditLogPage> => {
      const params: Record<string, string> = { ...definedFilterParams(filters), limit: String(limit) };
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<{ entries: WireAuditEntry[]; nextCursor: string | null }>('/api/admin/audit-log', {
        params,
      });
      return { ...response.data, entries: response.data.entries.map(reviveAuditEntry) };
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
    enabled,
  });
};

export const useAuditEntry = (id: string | null, initialEntry?: AuditEntry) =>
  useQuery({
    queryKey: ['admin', 'audit-log', 'entry', id],
    queryFn: async (): Promise<AuditEntry> => {
      const response = await api.get<WireAuditEntry>(`/api/admin/audit-log/${encodeURIComponent(id as string)}`);
      return reviveAuditEntry(response.data);
    },
    enabled: id !== null,
    initialData: initialEntry ? reviveAuditEntry(initialEntry) : undefined,
  });

export const useAuditSummary = (windowDays: AuditSummaryWindow) =>
  useQuery({
    queryKey: ['admin', 'audit-log', 'summary', windowDays],
    queryFn: async (): Promise<AuditSummary> => {
      const response = await api.get<AuditSummary>('/api/admin/audit-log/summary', { params: { window: windowDays } });
      return response.data;
    },
    staleTime: 1000 * 60 * 5,
  });

const filenameFromContentDisposition = (header: unknown): string => {
  if (typeof header !== 'string') return DEFAULT_EXPORT_FILENAME;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1] ?? DEFAULT_EXPORT_FILENAME;
};

/** Rejections propagate so the caller can toast; the server caps the export and flags it via header. */
export const downloadAuditLogCsv = async (filters: AuditLogFilters): Promise<{ truncated: boolean }> => {
  const response = await api.get<Blob>('/api/admin/audit-log/export', {
    params: definedFilterParams(filters),
    responseType: 'blob',
  });
  const truncated = String(response.headers['x-audit-export-truncated']).toLowerCase() === 'true';
  downloadData(
    response.data,
    filenameFromContentDisposition(response.headers['content-disposition']),
    'text/csv;charset=utf-8'
  );
  return { truncated };
};
