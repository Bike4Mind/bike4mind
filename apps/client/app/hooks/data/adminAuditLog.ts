import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import type {
  AuditAlertStatus,
  AuditEntry,
  AuditExportResult,
  AuditLogFilters,
  AuditLogPage,
  AuditReview,
  AuditReviewQueueEntry,
  AuditReviewQueuePage,
  AuditReviewQueueStatus,
  AuditSummary,
  AuditSummaryWindow,
  MarkAuditReviewedResult,
  UnmarkAuditReviewedResult,
} from '@bike4mind/common';
import { downloadUrl } from '@client/app/utils/download';

const DEFAULT_PAGE_SIZE = 50;
const MAX_ENTRY_RETRIES = 3;

const isNotFound = (error: unknown): boolean => isAxiosError(error) && error.response?.status === 404;

/** JSON carries `occurredAt` as an ISO string; consumers expect the real `AuditEntry` Date. */
export type WireAuditEntry = Omit<AuditEntry, 'occurredAt'> & { occurredAt: string | Date };

export const reviveAuditEntry = (entry: WireAuditEntry): AuditEntry => ({
  ...entry,
  occurredAt: new Date(entry.occurredAt),
});

const definedFilterParams = (filters: AuditLogFilters): Record<string, string> =>
  Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as Record<string, string>;

export const useAuditLog = (filters: AuditLogFilters, options: { enabled?: boolean; limit?: number } = {}) => {
  const { enabled = true, limit = DEFAULT_PAGE_SIZE } = options;
  return useInfiniteQuery({
    queryKey: ['admin', 'audit-log', 'list', filters, limit],
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
    // A missing entry will not appear on retry, and the page clears the URL as soon as this errors.
    retry: (failureCount, error) => !isNotFound(error) && failureCount < MAX_ENTRY_RETRIES,
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

export const useAuditAlertStatus = () =>
  useQuery({
    queryKey: ['admin', 'audit-log', 'alert-status'],
    queryFn: async (): Promise<AuditAlertStatus> => {
      const response = await api.get<AuditAlertStatus>('/api/admin/audit-log/alert-status');
      return response.data;
    },
    staleTime: 1000 * 60,
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

type WireAuditReview = Omit<AuditReview, 'reviewedAt'> & { reviewedAt: string | Date };
type WireAuditReviewQueueEntry = WireAuditEntry & { review: WireAuditReview | null };

const reviveAuditReview = (review: WireAuditReview): AuditReview => ({
  ...review,
  reviewedAt: new Date(review.reviewedAt),
});

const reviveReviewQueueEntry = (entry: WireAuditReviewQueueEntry): AuditReviewQueueEntry => ({
  ...reviveAuditEntry(entry),
  review: entry.review ? reviveAuditReview(entry.review) : null,
});

type ReviewQueueOptions = {
  /** ISO lower bound; required by the `all` status, ignored by `unreviewed`. */
  from?: string;
  limit?: number;
  enabled?: boolean;
};

export const useAuditReviewQueue = (status: AuditReviewQueueStatus, options: ReviewQueueOptions = {}) => {
  const { from, limit = DEFAULT_PAGE_SIZE, enabled = true } = options;
  return useInfiniteQuery({
    queryKey: ['admin', 'audit-log', 'review-queue', status, from, limit],
    queryFn: async ({ pageParam }): Promise<AuditReviewQueuePage> => {
      const params: Record<string, string> = { status, limit: String(limit) };
      if (from) params.from = from;
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<Omit<AuditReviewQueuePage, 'entries'> & { entries: WireAuditReviewQueueEntry[] }>(
        '/api/admin/audit-log/review-queue',
        { params }
      );
      return { ...response.data, entries: response.data.entries.map(reviveReviewQueueEntry) };
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
    enabled,
  });
};

/** How many critical entries wait for this admin; a one-row page is enough because `total` counts them all. */
export const useUnreviewedAuditCount = ({ enabled }: { enabled: boolean }) =>
  useQuery({
    queryKey: ['admin', 'audit-log', 'review-queue', 'count'],
    queryFn: async (): Promise<number> => {
      const response = await api.get<{ total: number }>('/api/admin/audit-log/review-queue', {
        params: { status: 'unreviewed', limit: '1' },
      });
      return response.data.total;
    },
    staleTime: 1000 * 60,
    enabled,
  });

export const useAuditReview = (entryId: string | null) =>
  useQuery({
    queryKey: ['admin', 'audit-log', 'review', entryId],
    queryFn: async (): Promise<AuditReview | null> => {
      const response = await api.get<{ review: WireAuditReview | null }>('/api/admin/audit-log/reviews', {
        params: { entryId },
      });
      return response.data.review ? reviveAuditReview(response.data.review) : null;
    },
    enabled: entryId !== null,
  });

export const useMarkAuditReviewed = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entryIds: string[]; note?: string }): Promise<MarkAuditReviewedResult> =>
      (await api.post<MarkAuditReviewedResult>('/api/admin/audit-log/reviews', input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'audit-log'] }),
    onError: () => toast.error('Could not mark the entries as reviewed. Refresh the list and try again.'),
  });
};

export const useUnmarkAuditReviewed = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entryIds: string[] }): Promise<UnmarkAuditReviewedResult> =>
      (await api.delete<UnmarkAuditReviewedResult>('/api/admin/audit-log/reviews', { data: input })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'audit-log'] }),
    onError: () => toast.error('Could not undo the review. Refresh the list and try again.'),
  });
};
