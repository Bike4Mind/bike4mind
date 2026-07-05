import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import type { RotatableIntegration } from '@bike4mind/common';

export type { RotatableIntegration };

interface RotateTokenResponse {
  authUrl: string;
}

const INTEGRATION_LABELS: Record<RotatableIntegration, string> = {
  github: 'GitHub',
  atlassian: 'Atlassian',
  slack: 'Slack',
  notion: 'Notion',
};

export const useRotateIntegrationToken = (integration: RotatableIntegration) => {
  return useMutation<RotateTokenResponse, Error, { reason?: string } | void>({
    mutationFn: async variables => {
      const reason = variables?.reason ?? 'manual_rotation';
      const { data } = await api.post<RotateTokenResponse>(`/api/integrations/${integration}/rotate-token`, { reason });
      return data;
    },
    onSuccess: ({ authUrl }) => {
      if (!authUrl || !authUrl.startsWith('https://')) {
        const label = INTEGRATION_LABELS[integration];
        console.error(`Invalid authUrl received for ${integration} token rotation:`, authUrl);
        toast.error(`Failed to get ${label} authorization URL. Please try again.`);
        return;
      }
      window.location.href = authUrl;
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      const label = INTEGRATION_LABELS[integration];
      console.error(`Failed to initiate ${label} token rotation`, error);
      const serverMessage = error.response?.data?.error;
      toast.error(serverMessage ?? `Failed to re-authorize ${label}. Please try again.`);
    },
  });
};
