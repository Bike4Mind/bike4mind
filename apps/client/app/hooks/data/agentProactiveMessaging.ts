import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { ISessionAgentConfigDocument, ISessionAgentConfigProactiveMessaging } from '@bike4mind/common';
import { toast } from 'sonner';

/**
 * Get proactive messaging config for a specific agent in a session
 */
export const useGetAgentProactiveConfig = (sessionId: string | null, agentId: string | null) => {
  return useQuery({
    queryKey: ['agent-proactive-config', sessionId, agentId],
    queryFn: async (): Promise<ISessionAgentConfigDocument | null> => {
      if (!sessionId || !agentId) return null;
      const response = await api.get<{ config: ISessionAgentConfigDocument | null }>(
        `/api/sessions/${sessionId}/agents/${agentId}/config`
      );
      return response.data.config;
    },
    enabled: !!sessionId && !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/**
 * Get all proactive messaging configs for a session
 */
export const useGetSessionAgentConfigs = (sessionId: string | null) => {
  return useQuery({
    queryKey: ['session-agent-configs', sessionId],
    queryFn: async (): Promise<ISessionAgentConfigDocument[]> => {
      if (!sessionId) return [];
      const response = await api.get<{ configs: ISessionAgentConfigDocument[] }>(
        `/api/sessions/${sessionId}/agents/configs`
      );
      return response.data.configs;
    },
    enabled: !!sessionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/**
 * Update proactive messaging config for an agent in a session
 */
export const useUpdateAgentProactiveConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      agentId,
      proactiveMessaging,
    }: {
      sessionId: string;
      agentId: string;
      proactiveMessaging: ISessionAgentConfigProactiveMessaging;
    }): Promise<ISessionAgentConfigDocument> => {
      const response = await api.put<{ config: ISessionAgentConfigDocument }>(
        `/api/sessions/${sessionId}/agents/${agentId}/config`,
        { proactiveMessaging }
      );
      return response.data.config;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agent-proactive-config', variables.sessionId, variables.agentId] });
      queryClient.invalidateQueries({ queryKey: ['session-agent-configs', variables.sessionId] });
      toast.success('Proactive messaging settings saved');
    },
    onError: (error: any) => {
      console.error('Failed to update proactive messaging config:', error);
      toast.error(error?.response?.data?.message || 'Failed to save settings');
    },
  });
};

/**
 * Delete proactive messaging config for an agent in a session
 */
export const useDeleteAgentProactiveConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, agentId }: { sessionId: string; agentId: string }): Promise<void> => {
      await api.delete(`/api/sessions/${sessionId}/agents/${agentId}/config`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agent-proactive-config', variables.sessionId, variables.agentId] });
      queryClient.invalidateQueries({ queryKey: ['session-agent-configs', variables.sessionId] });
      toast.success('Proactive messaging disabled');
    },
    onError: (error: any) => {
      console.error('Failed to delete proactive messaging config:', error);
      toast.error(error?.response?.data?.message || 'Failed to disable proactive messaging');
    },
  });
};

/**
 * Trigger proactive messages for all enabled agents in a session (for testing)
 */
export const useTriggerProactiveMessages = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      sessionId: string
    ): Promise<{
      success: boolean;
      message: string;
      triggeredCount: number;
      totalEnabledAgents: number;
      results: Array<{ agentId: string; agentName: string; success: boolean; error?: string }>;
    }> => {
      const response = await api.post(`/api/sessions/${sessionId}/agents/trigger-proactive-messages`);
      return response.data;
    },
    onSuccess: (data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['session-agent-configs', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });

      if (data.triggeredCount > 0) {
        toast.success(data.message);
      } else {
        toast.info(data.message);
      }
    },
    onError: (error: any) => {
      console.error('Failed to trigger proactive messages:', error);
      toast.error(error?.response?.data?.message || 'Failed to trigger proactive messages');
    },
  });
};
