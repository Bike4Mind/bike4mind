import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  IWebhookAuditLogDocument,
  IWebhookAuditPaginatedResult,
  IWebhookAuditSummary,
  WebhookAuditStatus,
  WebhookSourceType,
} from '@bike4mind/common';

/**
 * Filters for querying webhook audit logs
 */
export interface WebhookAuditFiltersParams {
  startDate?: string;
  endDate?: string;
  repository?: string;
  event?: string;
  status?: WebhookAuditStatus;
  organizationId?: string;
  mcpServerId?: string;
  sourceType?: WebhookSourceType;
  limit?: number;
}

/**
 * Date range for stats queries
 */
export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Build query params from filters, omitting undefined values
 */
function buildQueryParams(filters: WebhookAuditFiltersParams, cursor?: string): Record<string, string> {
  const params: Record<string, string> = {};

  if (filters.startDate) params.startDate = filters.startDate;
  if (filters.endDate) params.endDate = filters.endDate;
  if (filters.repository) params.repository = filters.repository;
  if (filters.event) params.event = filters.event;
  if (filters.status) params.status = filters.status;
  if (filters.organizationId) params.organizationId = filters.organizationId;
  if (filters.mcpServerId) params.mcpServerId = filters.mcpServerId;
  if (filters.sourceType) params.sourceType = filters.sourceType;
  if (filters.limit) params.limit = String(filters.limit);
  if (cursor) params.cursor = cursor;

  return params;
}

/**
 * Hook to fetch webhook audit logs with infinite scroll pagination
 */
export const useWebhookAuditLogs = (filters: WebhookAuditFiltersParams) => {
  return useInfiniteQuery({
    queryKey: ['admin', 'webhook-audit-logs', filters],
    queryFn: async ({ pageParam }) => {
      const params = buildQueryParams(filters, pageParam as string | undefined);
      const response = await api.get<IWebhookAuditPaginatedResult>('/api/admin/webhook-logs', { params });
      return response.data;
    },
    getNextPageParam: lastPage => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 60, // 1 minute
  });
};

/**
 * Hook to fetch a single webhook audit log by delivery ID
 */
export const useWebhookAuditLog = (deliveryId: string | null) => {
  return useQuery({
    queryKey: ['admin', 'webhook-audit-logs', deliveryId],
    queryFn: async () => {
      if (!deliveryId) throw new Error('Delivery ID is required');
      const response = await api.get<IWebhookAuditLogDocument>(`/api/admin/webhook-logs/${deliveryId}`);
      return response.data;
    },
    enabled: !!deliveryId,
  });
};

/**
 * Hook to fetch webhook audit statistics
 */
export const useWebhookAuditStats = (
  dateRange: DateRange,
  filters?: Omit<WebhookAuditFiltersParams, 'startDate' | 'endDate' | 'limit'>
) => {
  return useQuery({
    queryKey: ['admin', 'webhook-audit-stats', dateRange, filters],
    queryFn: async () => {
      const params: Record<string, string> = {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      };

      if (filters?.repository) params.repository = filters.repository;
      if (filters?.event) params.event = filters.event;
      if (filters?.status) params.status = filters.status;
      if (filters?.organizationId) params.organizationId = filters.organizationId;
      if (filters?.mcpServerId) params.mcpServerId = filters.mcpServerId;
      if (filters?.sourceType) params.sourceType = filters.sourceType;

      const response = await api.get<IWebhookAuditSummary>('/api/admin/webhook-logs/stats', { params });
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes - stats don't change frequently
  });
};

/**
 * Helper function to get date range presets
 */
export function getDateRangePreset(preset: '24h' | '7d' | '30d' | '90d'): DateRange {
  const now = new Date();
  const endDate = now.toISOString();

  let startDate: string;
  switch (preset) {
    case '24h':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      break;
    case '7d':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      break;
    case '30d':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      break;
    case '90d':
      startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
      break;
  }

  return { startDate, endDate };
}
