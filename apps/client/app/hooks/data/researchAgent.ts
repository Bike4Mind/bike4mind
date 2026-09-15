import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { IResearchAgent } from '@bike4mind/common';

export interface CreateResearchAgentInput {
  name: string;
  description: string;
}

export interface UpdateResearchAgentInput {
  name?: string;
  description?: string;
}

export interface SearchResearchAgentsParams {
  search?: string;
  page?: number;
  limit?: number;
  orderBy?: {
    by: string;
    direction: 'asc' | 'desc';
  };
}

export function useSearchResearchAgents(params: SearchResearchAgentsParams = {}) {
  const { search = '', page = 1, limit = 10, orderBy = { by: 'createdAt', direction: 'desc' } } = params;

  return useQuery({
    queryKey: ['research-agents', 'search', { search, page, limit, orderBy }],
    queryFn: async () => {
      const response = await api.get<{
        data: IResearchAgent[];
        hasMore: boolean;
        total: number;
      }>('/api/research/agents', {
        params: {
          search,
          page,
          limit,
          orderBy,
        },
      });
      return response.data;
    },
  });
}

export function useGetResearchAgent(agentId?: string) {
  return useQuery({
    queryKey: ['research-agents', agentId],
    queryFn: async () => {
      const response = await api.get<IResearchAgent>(`/api/research/agents/${agentId}`);
      return response.data;
    },
    enabled: !!agentId,
  });
}

export function useCreateResearchAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateResearchAgentInput) => {
      const response = await api.post<IResearchAgent>('/api/research/agents', input);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['research-agents'] });
      toast.success('Research agent created successfully');
    },
    onError: error => {
      console.error('Failed to create research agent:', error);
      toast.error('Failed to create research agent');
    },
  });
}

export function useUpdateResearchAgent(agentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateResearchAgentInput) => {
      const response = await api.post<IResearchAgent>(`/api/research/agents/${agentId}`, input);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['research-agents'] });
      queryClient.invalidateQueries({ queryKey: ['research-agents', data.id] });
      toast.success('Research agent updated successfully');
    },
    onError: error => {
      console.error('Failed to update research agent:', error);
      toast.error('Failed to update research agent');
    },
  });
}

export function useDeleteResearchAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (agentId: string) => {
      await api.delete(`/api/research/agents/${agentId}`);
      return agentId;
    },
    onSuccess: agentId => {
      queryClient.invalidateQueries({ queryKey: ['research-agents'] });
      queryClient.invalidateQueries({ queryKey: ['research-agents', agentId] });
      toast.success('Research agent deleted successfully');
    },
    onError: error => {
      console.error('Failed to delete research agent:', error);
      toast.error('Failed to delete research agent');
    },
  });
}

export function useGetResearchAgentTasks(agentId?: string) {
  return useQuery({
    queryKey: ['research-agents', agentId, 'tasks'],
    queryFn: async () => {
      const response = await api.get<{
        data: IResearchAgent[];
        hasMore: boolean;
        total: number;
      }>(`/api/research/agents/${agentId}/tasks`);
      return response.data;
    },
    enabled: !!agentId,
  });
}

export function useGetResearchAgents() {
  return useQuery({
    queryKey: ['research-agents'],
    queryFn: async () => {
      const response = await api.get<IResearchAgent[]>('/api/research/agents');
      return response.data;
    },
  });
}
