/**
 * Organization Webhook Configuration Data Hooks
 *
 * Provides React Query hooks for managing organization-level GitHub webhook configuration.
 * Used in the admin UI for setting up and managing webhooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IOrgWebhookConfigRequest, IOrgWebhookConfigResponse } from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

/**
 * Query key for organization webhook config
 */
export const orgWebhookQueryKeys = {
  all: ['org-webhooks'] as const,
  config: (orgId: string) => ['org-webhooks', orgId, 'config'] as const,
};

/**
 * Hook to get organization webhook configuration
 */
export function useGetOrgWebhookConfig(orgId: string | null | undefined, options?: { revealSecret?: boolean }) {
  return useQuery({
    queryKey: [...orgWebhookQueryKeys.config(orgId || ''), { revealSecret: options?.revealSecret }],
    queryFn: async () => {
      if (!orgId) return null;
      const response = await api.get<IOrgWebhookConfigResponse>(`/api/organizations/${orgId}/webhooks/github`, {
        params: { revealSecret: options?.revealSecret ? 'true' : undefined },
      });
      return response.data;
    },
    enabled: !!orgId,
    retry: (failureCount, error) => {
      // Don't retry on 404 (config doesn't exist)
      if ((error as { response?: { status: number } })?.response?.status === 404) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

/**
 * Hook to create organization webhook configuration
 */
export function useCreateOrgWebhookConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, data }: { orgId: string; data: IOrgWebhookConfigRequest }) => {
      const response = await api.post<IOrgWebhookConfigResponse>(`/api/organizations/${orgId}/webhooks/github`, data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: orgWebhookQueryKeys.all });
      queryClient.setQueryData(orgWebhookQueryKeys.config(data.organizationId), data);
      toast.success('Webhook configuration created successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to update organization webhook configuration
 */
export function useUpdateOrgWebhookConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, data }: { orgId: string; data: Partial<IOrgWebhookConfigRequest> }) => {
      const response = await api.put<IOrgWebhookConfigResponse>(`/api/organizations/${orgId}/webhooks/github`, data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: orgWebhookQueryKeys.config(data.organizationId) });
      toast.success('Webhook configuration updated successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to delete organization webhook configuration
 */
export function useDeleteOrgWebhookConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      await api.delete(`/api/organizations/${orgId}/webhooks/github`);
      return orgId;
    },
    onSuccess: orgId => {
      queryClient.invalidateQueries({ queryKey: orgWebhookQueryKeys.all });
      queryClient.removeQueries({ queryKey: orgWebhookQueryKeys.config(orgId) });
      toast.success('Webhook configuration deleted successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to rotate organization webhook secret
 */
export function useRotateOrgWebhookSecret() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      const response = await api.post<IOrgWebhookConfigResponse>(
        `/api/organizations/${orgId}/webhooks/github/rotate-secret`
      );
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: orgWebhookQueryKeys.config(data.organizationId) });
      toast.success('Webhook secret rotated successfully. Please update your GitHub webhook settings.');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to test webhook endpoint
 */
export function useTestOrgWebhook() {
  return useMutation({
    mutationFn: async ({ orgId, targetUrl }: { orgId: string; targetUrl?: string }) => {
      const response = await api.post<{
        success: boolean;
        statusCode: number;
        latencyMs: number;
        error?: string;
      }>(`/api/organizations/${orgId}/webhooks/github/test`, { targetUrl });
      return response.data;
    },
    onSuccess: data => {
      if (data.success) {
        toast.success(`Webhook test successful (${data.latencyMs}ms)`);
      } else {
        toast.error(`Webhook test failed: ${data.error || `HTTP ${data.statusCode}`}`);
      }
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to replay failed deliveries from DLQ
 */
export function useReplayDLQ() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, deliveryIds, all }: { orgId: string; deliveryIds?: string[]; all?: boolean }) => {
      const response = await api.post<{
        success: boolean;
        replayed: number;
        message: string;
      }>(`/api/organizations/${orgId}/webhooks/github/replay-dlq`, { deliveryIds, all });
      return response.data;
    },
    onSuccess: data => {
      if (data.success) {
        toast.success(`Successfully queued ${data.replayed} deliveries for replay`);
        queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] });
      } else {
        toast.error(data.message);
      }
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
