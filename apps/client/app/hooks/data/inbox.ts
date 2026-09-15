import {
  deleteInboxItemFromServer as deleteInboxItem,
  fetchInbox,
  readInboxMessages,
  sendMessage,
  sendSystemMessage,
} from '@client/app/utils/inboxAPICalls';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useGetInbox(userId: string | null) {
  return useQuery({
    queryKey: ['inboxes'],
    queryFn: () => fetchInbox(userId || undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchInterval: 1000 * 60 * 1, // 1 minute
    enabled: !!userId, // Fetch only when currentUser is not null or undefined
  });
}

export function useReadInboxItems() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids: string[]) => await readInboxMessages(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox/read'] });
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to set read inbox');
    },
  });
}

export function useSendInboxitem({ onSuccess, onSettled }: { onSuccess: () => void; onSettled: () => void }) {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, { title: string; message: string; receiver: string }>({
    mutationFn: data => sendMessage(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox/create'] });
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      if (onSuccess) onSuccess();
      toast.success('Message sent');
    },
    onError: error => {
      const errorMessage =
        (error as any)?.response?.data?.error ||
        (error as any)?.response?.data?.message ||
        error?.message ||
        'Failed to send message';

      toast.error(errorMessage);
    },
    onSettled: () => onSettled(),
  });
}

export function useDeleteInbox({ onSettled }: { onSettled: () => void }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => await deleteInboxItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox/delete'] });
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      toast.success('Successfully deleted message');
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to delete inbox message');
    },
    onSettled: () => onSettled(),
  });
}

export function useSendSystemMessage({
  onSuccess,
  onError,
}: { onSuccess?: () => void; onError?: (error: Error) => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, { title: string; message: string; receiverId: string }>({
    mutationFn: data => sendSystemMessage(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox/admin-send'] });
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      if (onSuccess) onSuccess();
      toast.success('System message sent');
    },
    onError: error => {
      if (onError) onError(error);
      toast.error('Failed to send system message');
    },
  });
}
