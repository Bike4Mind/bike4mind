import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getVoiceFromServer, upsertVoice } from '@client/app/utils/voiceCalls';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';

export function useGetAllVoice() {
  return useQuery({ queryKey: ['elabs/voice'], queryFn: () => getVoiceFromServer() });
}

export function useSetVoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/api/elabs/voice/${id}/set-active`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['elabs/voice'] });
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to set voice');
    },
  });
}

export function useAddNewVoice({ onSuccess }: { onSuccess?: () => void }) {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, { keySpec: string; description: string; isActive: boolean }>({
    mutationFn: data => upsertVoice(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['elabs/voice'] });
      if (onSuccess) onSuccess();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to add voice');
    },
  });
}

export function useDeleteVoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/elabs/voice/${id}`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['elabs/voice'] });
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to delete voice');
    },
  });
}
