/**
 * Webhook Subscription Data Hooks
 *
 * Provides React Query hooks for managing user webhook subscriptions.
 * Used in the user UI for subscribing to organization webhooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IWebhookSubscriptionRequest, IWebhookSubscriptionResponse } from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

/**
 * Query key for webhook subscriptions
 */
export const webhookSubscriptionQueryKeys = {
  all: ['webhook-subscriptions'] as const,
  list: () => ['webhook-subscriptions', 'list'] as const,
  detail: (id: string) => ['webhook-subscriptions', id] as const,
};

/**
 * Hook to get all user's webhook subscriptions
 */
export function useGetWebhookSubscriptions() {
  return useQuery({
    queryKey: webhookSubscriptionQueryKeys.list(),
    queryFn: async () => {
      const response = await api.get<IWebhookSubscriptionResponse[]>('/api/webhooks/github/subscriptions');
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Hook to get a single webhook subscription
 */
export function useGetWebhookSubscription(id: string | null | undefined) {
  return useQuery({
    queryKey: webhookSubscriptionQueryKeys.detail(id || ''),
    queryFn: async () => {
      if (!id) return null;
      const response = await api.get<IWebhookSubscriptionResponse>(`/api/webhooks/github/subscriptions/${id}`);
      return response.data;
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Hook to create a webhook subscription
 */
export function useCreateWebhookSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: IWebhookSubscriptionRequest) => {
      const response = await api.post<IWebhookSubscriptionResponse>('/api/webhooks/github/subscriptions', data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: webhookSubscriptionQueryKeys.all });
      queryClient.setQueryData(webhookSubscriptionQueryKeys.detail(data.id), data);
      toast.success('Subscribed to webhook events successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to update a webhook subscription
 */
export function useUpdateWebhookSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<IWebhookSubscriptionRequest> }) => {
      const response = await api.put<IWebhookSubscriptionResponse>(`/api/webhooks/github/subscriptions/${id}`, data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: webhookSubscriptionQueryKeys.list() });
      queryClient.setQueryData(webhookSubscriptionQueryKeys.detail(data.id), data);
      toast.success('Subscription updated successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to delete a webhook subscription
 */
export function useDeleteWebhookSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/webhooks/github/subscriptions/${id}`);
      return id;
    },
    onSuccess: id => {
      queryClient.invalidateQueries({ queryKey: webhookSubscriptionQueryKeys.all });
      queryClient.removeQueries({ queryKey: webhookSubscriptionQueryKeys.detail(id) });
      toast.success('Unsubscribed from webhook events');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to re-enable an auto-disabled subscription
 */
export function useReEnableWebhookSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post<IWebhookSubscriptionResponse>(
        `/api/webhooks/github/subscriptions/${id}/re-enable`
      );
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: webhookSubscriptionQueryKeys.list() });
      queryClient.setQueryData(webhookSubscriptionQueryKeys.detail(data.id), data);
      toast.success('Subscription re-enabled successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
