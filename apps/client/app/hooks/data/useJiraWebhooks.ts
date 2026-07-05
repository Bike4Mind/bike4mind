/**
 * Jira Webhook Configuration & Subscription Data Hooks
 *
 * Provides React Query hooks for managing Jira webhook configs and subscriptions.
 * Used in the Profile -> Integrations page for setting up Jira -> Slack notifications.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  IJiraWebhookConfigRequest,
  IJiraWebhookConfigResponse,
  IJiraWebhookSubscriptionRequest,
  IJiraWebhookSubscriptionResponse,
} from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

/**
 * Query keys for Jira webhook data
 */
export const jiraWebhookQueryKeys = {
  all: ['jira-webhooks'] as const,
  config: () => ['jira-webhooks', 'config'] as const,
  subscriptions: () => ['jira-webhooks', 'subscriptions'] as const,
  subscription: (id: string) => ['jira-webhooks', 'subscriptions', id] as const,
};

// ============================================================================
// Webhook Config Hooks
// ============================================================================

/**
 * Hook to get Jira webhook configuration for the current user's Atlassian site
 */
export function useGetJiraWebhookConfig(options?: { revealSecret?: boolean }) {
  return useQuery({
    queryKey: [...jiraWebhookQueryKeys.config(), { revealSecret: options?.revealSecret }],
    queryFn: async () => {
      const response = await api.get<IJiraWebhookConfigResponse | null>('/api/webhooks/jira/config', {
        params: { revealSecret: options?.revealSecret ? 'true' : undefined },
      });
      return response.data;
    },
    retry: (failureCount, error) => {
      // Don't retry on 401 (no Atlassian connection)
      const status = (error as { response?: { status: number } })?.response?.status;
      if (status === 401) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

/**
 * Hook to create Jira webhook configuration
 */
export function useCreateJiraWebhookConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: IJiraWebhookConfigRequest) => {
      const response = await api.post<IJiraWebhookConfigResponse>('/api/webhooks/jira/config', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: jiraWebhookQueryKeys.config() });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to update Jira webhook configuration
 */
export function useUpdateJiraWebhookConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: Partial<IJiraWebhookConfigRequest>) => {
      const response = await api.put<IJiraWebhookConfigResponse>('/api/webhooks/jira/config', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: jiraWebhookQueryKeys.config() });
      toast.success('Jira webhook configuration updated');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to delete Jira webhook configuration
 */
export function useDeleteJiraWebhookConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await api.delete<{ success: boolean; message: string; deletedSubscriptions?: number }>(
        '/api/webhooks/jira/config'
      );
      return response.data;
    },
    onSuccess: data => {
      // Remove queries instead of invalidating to avoid a refetch that 404s
      queryClient.removeQueries({ queryKey: jiraWebhookQueryKeys.all });
      toast.success(data.message);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

// ============================================================================
// Subscription Hooks
// ============================================================================

/**
 * Hook to list Jira webhook subscriptions for the current user
 */
export function useGetJiraWebhookSubscriptions() {
  return useQuery({
    queryKey: jiraWebhookQueryKeys.subscriptions(),
    queryFn: async () => {
      const response = await api.get<IJiraWebhookSubscriptionResponse[]>('/api/webhooks/jira/subscriptions');
      return response.data;
    },
    retry: (failureCount, error) => {
      const status = (error as { response?: { status: number } })?.response?.status;
      if (status === 401) return false;
      return failureCount < 3;
    },
  });
}

/**
 * Hook to create a Jira webhook subscription
 */
export function useCreateJiraWebhookSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: IJiraWebhookSubscriptionRequest) => {
      const response = await api.post<IJiraWebhookSubscriptionResponse>('/api/webhooks/jira/subscriptions', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: jiraWebhookQueryKeys.subscriptions() });
      queryClient.invalidateQueries({ queryKey: jiraWebhookQueryKeys.config() });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to update a Jira webhook subscription
 */
export function useUpdateJiraWebhookSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<IJiraWebhookSubscriptionRequest> }) => {
      const response = await api.put<IJiraWebhookSubscriptionResponse>(`/api/webhooks/jira/subscriptions/${id}`, data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: jiraWebhookQueryKeys.subscriptions() });
      queryClient.setQueryData(jiraWebhookQueryKeys.subscription(data.id), data);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to delete a Jira webhook subscription
 */
export function useDeleteJiraWebhookSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/webhooks/jira/subscriptions/${id}`);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: jiraWebhookQueryKeys.subscriptions() });
      queryClient.invalidateQueries({ queryKey: jiraWebhookQueryKeys.config() });
      toast.success('Subscription deleted');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
