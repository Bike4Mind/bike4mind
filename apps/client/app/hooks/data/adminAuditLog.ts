import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  AuditEntry,
  AuditExportResult,
  AuditLogFilters,
  AuditLogPage,
  AuditSummary,
  AuditSummaryWindow,
} from '@bike4mind/common';
import { downloadUrl } from '@client/app/utils/download';

const DEFAULT_PAGE_SIZE = 50;

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
    // Only seed from the entry the caller resolved for this id; a stale one would flash the wrong drawer.
    initialData: initialEntry && initialEntry.id === id ? reviveAuditEntry(initialEntry) : undefined,
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

/**
 * Rejections propagate so the caller can toast. The server stages the capped CSV in storage and returns a
 * short-lived signed URL whose Content-Disposition names the file, so the browser downloads it directly.
 */
export const downloadAuditLogCsv = async (filters: AuditLogFilters): Promise<{ truncated: boolean }> => {
  const response = await api.get<AuditExportResult>('/api/admin/audit-log/export', {
    params: definedFilterParams(filters),
  });
  const { url, fileName, truncated } = response.data;
  downloadUrl(url, fileName);
  return { truncated };
};
