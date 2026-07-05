import { IChatHistoryItemDocument, IQuestMasterPlanDocument, SubQuestStatus } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { deleteChatMessage, getChatMessage, updateChatMessage } from '@client/app/utils/sessionsAPICalls';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export const useDeleteQuest = (queryClient: QueryClient) => {
  return useMutation({
    mutationFn: async ({ sessionId, id }: { sessionId: string; id: string }) => {
      await deleteChatMessage(sessionId, id);
      updateAllQueryData(queryClient, 'quests', 'delete', { id });
    },
    onSuccess: () => {
      toast.success('Snipped!');
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to delete message');
    },
  });
};

export const useUpdateQuest = (queryClient: QueryClient) => {
  return useMutation({
    mutationFn: async ({
      sessionId,
      id,
      update,
    }: {
      sessionId: string;
      id: string;
      update: { reply?: string; replies?: string[]; pinned?: boolean };
    }) => {
      await updateChatMessage(sessionId, id, update);
      updateAllQueryData(queryClient, 'quests', 'write', { id, ...update });
    },
    onSuccess: (_, { update }) => {
      if ('pinned' in update) {
        // Pin/unpin operation - don't show success toast as it's handled in the component
        return;
      }
      toast.success('Updated!');
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to update response');
    },
  });
};

export const useGetQuest = (sessionId: string, questId: string, enabled = true) => {
  return useQuery<IChatHistoryItemDocument>({
    queryKey: ['quests', 'individual', sessionId, questId],
    queryFn: async () => {
      return getChatMessage(sessionId, questId);
    },
    enabled: enabled && !!sessionId && !!questId,
    staleTime: 0,
    gcTime: 30000, // Keep cache for 30s to allow late-binding queries to find streaming updates
    refetchOnWindowFocus: false, // Don't interfere with manual polling
  });
};

export const useGetQuestMasterPlan = (questMasterPlanId: string) => {
  return useQuery({
    queryKey: ['quest-master-plans', questMasterPlanId],
    queryFn: async () => {
      const { data } = await api.get<IQuestMasterPlanDocument>(`/api/quest-master-plans/${questMasterPlanId}`);
      return data;
    },
  });
};

export const useUpdateQuestProgress = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      planId,
      questId,
      subQuestId,
      status,
      timeSpent,
      chatMessageId,
      startedAt,
    }: {
      planId: string;
      questId: string;
      subQuestId: string;
      status?: SubQuestStatus;
      timeSpent?: number;
      chatMessageId?: string;
      startedAt?: number;
    }) => {
      const { data } = await api.patch(`/api/quest-plans/${planId}/progress`, {
        questId,
        subQuestId,
        status,
        timeSpent,
        chatMessageId,
        startedAt,
      });
      return data;
    },
    // OPTIMISTIC UPDATE - immediately update UI before server responds
    onMutate: async ({ planId, questId, subQuestId, status, chatMessageId, startedAt }) => {
      // Cancel outgoing refetches to prevent overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: ['quest-master-plans', planId] });

      // Snapshot previous value for rollback
      const previousPlan = queryClient.getQueryData<IQuestMasterPlanDocument>(['quest-master-plans', planId]);

      // Optimistically update the cache
      queryClient.setQueryData<IQuestMasterPlanDocument>(['quest-master-plans', planId], old => {
        if (!old) return old;
        return {
          ...old,
          quests: old.quests.map(q =>
            q.id === questId
              ? {
                  ...q,
                  subQuests: q.subQuests.map(sq =>
                    sq.id === subQuestId
                      ? {
                          ...sq,
                          status: status || sq.status,
                          questId: chatMessageId || sq.questId,
                          startedAt: startedAt || sq.startedAt,
                        }
                      : sq
                  ),
                }
              : q
          ),
        };
      });

      return { previousPlan };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousPlan) {
        queryClient.setQueryData(['quest-master-plans', variables.planId], context.previousPlan);
      }
      console.error('Failed to update quest progress:', err);
      toast.error('Failed to update quest progress');
    },
    onSuccess: (data, variables) => {
      // Server confirmed - update with server response (authoritative)
      queryClient.setQueryData(['quest-master-plans', variables.planId], data.plan);
    },
  });
};
