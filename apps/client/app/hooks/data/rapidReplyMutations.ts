import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IRapidReplyMapping } from '@bike4mind/common/types/entities/RapidReplyTypes';

// Mutation hooks for Rapid Reply functionality
export const useSaveMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mapping: Partial<IRapidReplyMapping>) => {
      const url = mapping.id ? `/api/admin/rapid-reply/mappings/${mapping.id}` : '/api/admin/rapid-reply/mappings';

      if (mapping.id) {
        const response = await api.put(url, mapping);
        return response.data;
      } else {
        const response = await api.post(url, mapping);
        return response.data;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rapid-reply-mappings'] });
    },
  });
};

export const useDeleteMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.delete(`/api/admin/rapid-reply/mappings/${id}`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rapid-reply-mappings'] });
    },
  });
};

export const useTestConfiguration = () => {
  return useMutation({
    mutationFn: async ({ mainModelId, testInput }: { mainModelId: string; testInput?: string }) => {
      const response = await api.post('/api/admin/rapid-reply/test', { mainModelId, testInput });
      return response.data;
    },
  });
};
