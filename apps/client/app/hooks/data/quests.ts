import { IChatHistoryItemDocument, SuggestedChoices } from '@bike4mind/common';
import type { ContextBreakdown } from '@bike4mind/services';
import { api } from '@client/app/contexts/ApiContext';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { deleteChatMessage, getChatMessage, updateChatMessage } from '@client/app/utils/sessionsAPICalls';
import { QueryClient, useMutation, useQuery } from '@tanstack/react-query';
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

/**
 * Marks a reply choice as picked: cache first, so the button row settles at once, then the server.
 * No toast on failure - the pick's text is sent as the user's reply regardless, so the only loss
 * is the highlight on reload.
 */
export const recordReplyChoice = async (
  queryClient: QueryClient,
  {
    sessionId,
    questId,
    suggestedChoices,
    index,
  }: { sessionId: string; questId: string; suggestedChoices: SuggestedChoices; index: number }
) => {
  updateAllQueryData(queryClient, 'quests', 'write', {
    id: questId,
    suggestedChoices: { ...suggestedChoices, selectedIndex: index },
  });
  try {
    await updateChatMessage(sessionId, questId, { selectedChoiceIndex: index });
  } catch (error) {
    console.error('Failed to record reply choice', error);
  }
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

/**
 * The signed-in user's own /context breakdown for one of their quests. Owner-only server-side, and
 * lazy: nothing is requested until the reader opens the panel.
 */
export const useQuestContextBreakdown = (questId: string | undefined, enabled: boolean) => {
  return useQuery<ContextBreakdown>({
    queryKey: ['quests', 'context', questId],
    queryFn: async () => {
      const { data } = await api.get<ContextBreakdown>(`/api/quests/${questId}/context`);
      return data;
    },
    enabled: enabled && !!questId,
    refetchOnWindowFocus: false,
  });
};
