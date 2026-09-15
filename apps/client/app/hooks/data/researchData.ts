import { IResearchData, IResearchTaskWithData } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { IFabFileDocument } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useGetResearchDataFiles(options?: { enabled?: boolean }) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: ['research-data', 'files'],
    queryFn: async () => {
      const { data } = await api.get<IFabFileDocument[]>('/api/research/data/files');
      return data;
    },
    enabled,
  });
}

export function useDeleteResearchData() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (researchData: IResearchData) => {
      const { researchAgentId, researchTaskId, id } = researchData;
      // Optimistic Update
      try {
        queryClient.setQueryData(['research-tasks', researchData.researchTaskId], (prev: IResearchTaskWithData) => {
          prev.researchData = prev.researchData?.filter(d => d.id !== researchData.id);
          return prev;
        });
      } catch (e) {
        console.log(e);
      }
      await api.delete(`/api/research/agents/${researchAgentId}/tasks/${researchTaskId}/data/${id}`);

      return researchData;
    },
    onSuccess: researchData => {
      toast.success('Research data deleted successfully');
    },
    onError: () => {
      toast.error('Failed to delete research data');
    },
  });
}
