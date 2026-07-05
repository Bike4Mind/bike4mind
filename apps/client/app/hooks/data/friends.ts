import { IFriendshipDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useSendFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { email: string; message?: string }) => {
      await api.post('/api/friends', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friends'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
      toast.success('Friend request sent');
    },
    onError: error => {
      toast.error(getErrorMessage(error));
    },
  });
}

export function useRespondToFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { id: string; accept: boolean }) => {
      await api.patch(`/api/friends/${data.id}/respond`, {
        accept: data.accept,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friends'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
      toast.success('Friend request responded');
    },
    onError: error => {
      toast.error(getErrorMessage(error));
    },
  });
}

export function useUnfriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/friends/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friends'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
      toast.success('Friend removed');
    },
    onError: error => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Get friendship by friend's user ID and current user ID
 */
export function useGetFriendshipByUserId(userId: string | undefined | null) {
  return useQuery({
    queryKey: ['friends', 'by-user', userId],
    queryFn: async () => {
      const { data } = await api.get<IFriendshipDocument>(`/api/friends/by-user/${userId}`);
      return data;
    },
    staleTime: 1000 * 60 * 3, // 3 minutes
    enabled: !!userId,
  });
}
