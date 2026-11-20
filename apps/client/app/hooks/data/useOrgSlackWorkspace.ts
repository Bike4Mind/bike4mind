import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IOrgSlackWorkspaceResponse } from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

export const orgSlackQueryKeys = {
  all: ['org-slack'] as const,
  workspace: (orgId: string) => ['org-slack', orgId, 'workspace'] as const,
  apiPostingChannels: (orgId: string) => ['org-slack', orgId, 'api-posting-channels'] as const,
};

/** A channel's opt-in for `POST /api/v1/slack/messages`, as the channels route returns it. */
export interface OrgSlackApiPostingChannel {
  channelId: string;
  apiPostEnabled: boolean;
  apiPostAllowedKeyIds: string[];
  /** Present only on an enable: whether the bot is already in the channel. */
  botIsMember?: boolean;
}

/**
 * Get the org's connected Slack workspace
 */
export function useGetOrgSlackWorkspace(orgId: string | null | undefined) {
  return useQuery({
    queryKey: orgSlackQueryKeys.workspace(orgId || ''),
    queryFn: async () => {
      if (!orgId) return null;
      try {
        const response = await api.get<IOrgSlackWorkspaceResponse>(`/api/organizations/${orgId}/integrations/slack`);
        return response.data;
      } catch (error) {
        // 404 means no workspace connected - return null instead of throwing
        if ((error as { response?: { status: number } })?.response?.status === 404) {
          return null;
        }
        throw error;
      }
    },
    enabled: !!orgId,
  });
}

/**
 * Start Slack OAuth connect flow - returns the URL to redirect to
 */
export function useConnectOrgSlack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      const response = await api.post<{ url: string }>(`/api/organizations/${orgId}/integrations/slack/connect`);
      return response.data;
    },
    onSuccess: (_data, orgId) => {
      queryClient.invalidateQueries({ queryKey: orgSlackQueryKeys.workspace(orgId) });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Disconnect Slack workspace from org
 */
export function useDisconnectOrgSlack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      const response = await api.delete<{ success: boolean; message: string }>(
        `/api/organizations/${orgId}/integrations/slack`
      );
      return response.data;
    },
    onSuccess: (_data, orgId) => {
      queryClient.invalidateQueries({ queryKey: orgSlackQueryKeys.all });
      queryClient.removeQueries({ queryKey: orgSlackQueryKeys.workspace(orgId) });
      toast.success('Slack workspace disconnected');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Channels of the org's workspace that API keys with `slack:post` may post to
 */
export function useGetOrgSlackApiPostingChannels(orgId: string | null | undefined) {
  return useQuery({
    queryKey: orgSlackQueryKeys.apiPostingChannels(orgId || ''),
    queryFn: async () => {
      const response = await api.get<{ channels: OrgSlackApiPostingChannel[] }>(
        `/api/organizations/${orgId}/integrations/slack/channels`
      );
      return response.data.channels;
    },
    enabled: !!orgId,
  });
}

/**
 * Turn API posting on or off for one channel
 */
export function useSetOrgSlackChannelApiPosting(orgId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (update: { channelId: string; apiPostEnabled: boolean; apiPostAllowedKeyIds?: string[] }) => {
      const response = await api.put<OrgSlackApiPostingChannel>(
        `/api/organizations/${orgId}/integrations/slack/channels`,
        update
      );
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgSlackQueryKeys.apiPostingChannels(orgId) });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
