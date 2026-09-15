/**
 * Webhook Delivery Data Hooks
 *
 * Provides React Query hooks for viewing webhook delivery history.
 * Used in the user UI for monitoring delivery status and retrying failed deliveries.
 */

import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IWebhookDeliveryDocument, WebhookDeliveryStatus } from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

/**
 * Extended delivery response with pagination metadata
 */
export interface IWebhookDeliveryListResponse {
  deliveries: IWebhookDeliveryDocument[];
  pagination: {
    skip: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

/**
 * Query key for webhook deliveries
 */
export const webhookDeliveryQueryKeys = {
  all: ['webhook-deliveries'] as const,
  list: (filters?: { subscriptionId?: string; status?: WebhookDeliveryStatus; since?: string }) =>
    ['webhook-deliveries', 'list', filters] as const,
  detail: (id: string) => ['webhook-deliveries', id] as const,
};

/**
 * Hook to get paginated webhook delivery history
 */
export function useGetWebhookDeliveries(filters?: {
  subscriptionId?: string;
  status?: WebhookDeliveryStatus;
  since?: string;
  limit?: number;
}) {
  const queryClient = useQueryClient();
  const limit = filters?.limit || 20;

  return useInfiniteQuery({
    queryKey: webhookDeliveryQueryKeys.list(filters),
    initialPageParam: { skip: 0 },
    queryFn: async ({ pageParam }) => {
      const response = await api.get<IWebhookDeliveryListResponse>('/api/webhooks/deliveries', {
        params: {
          subscriptionId: filters?.subscriptionId,
          status: filters?.status,
          since: filters?.since,
          skip: pageParam.skip,
          limit,
        },
      });

      // Cache individual deliveries
      response.data.deliveries.forEach(delivery => {
        queryClient.setQueryData(webhookDeliveryQueryKeys.detail(delivery.id), delivery);
      });

      return response.data;
    },
    getNextPageParam: lastPage => {
      if (lastPage.pagination.hasMore) {
        return { skip: lastPage.pagination.skip + lastPage.pagination.limit };
      }
      return undefined;
    },
    staleTime: 1000 * 30, // 30 seconds - deliveries change frequently
  });
}

/**
 * Hook to get a single webhook delivery
 */
export function useGetWebhookDelivery(id: string | null | undefined) {
  return useQuery({
    queryKey: webhookDeliveryQueryKeys.detail(id || ''),
    queryFn: async () => {
      if (!id) return null;
      const response = await api.get<IWebhookDeliveryDocument>(`/api/webhooks/deliveries/${id}`);
      return response.data;
    },
    enabled: !!id,
    staleTime: 1000 * 30,
  });
}

/**
 * Hook to retry a failed webhook delivery
 */
export function useRetryWebhookDelivery() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (deliveryId: string) => {
      const response = await api.post<{
        success: boolean;
        message: string;
        newDeliveryId?: string;
      }>(`/api/webhooks/deliveries/${deliveryId}/retry`);
      return response.data;
    },
    onSuccess: (data, deliveryId) => {
      if (data.success) {
        queryClient.invalidateQueries({ queryKey: webhookDeliveryQueryKeys.all });
        toast.success('Delivery queued for retry');
      } else {
        toast.error(data.message);
      }
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to get delivery statistics for a subscription
 */
export function useGetDeliveryStats(subscriptionId: string | null | undefined) {
  return useQuery({
    queryKey: ['webhook-delivery-stats', subscriptionId],
    queryFn: async () => {
      if (!subscriptionId) return null;
      const response = await api.get<{
        total: number;
        success: number;
        failed: number;
        pending: number;
        skipped: number;
        lastDeliveryAt?: string;
        successRate: number;
      }>(`/api/webhooks/deliveries/stats`, {
        params: { subscriptionId },
      });
      return response.data;
    },
    enabled: !!subscriptionId,
    staleTime: 1000 * 60, // 1 minute
  });
}
