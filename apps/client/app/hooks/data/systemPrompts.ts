import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IAdminSystemPrompt } from '@bike4mind/common';

/**
 * Hook to fetch all system prompts with optional filtering
 */
export function useSystemPrompts(filters?: {
  category?: string;
  enabled?: 'true' | 'false' | 'all';
  search?: string;
  source?: 'code' | 'db' | 'all';
}) {
  return useQuery({
    queryKey: ['system-prompts', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.category) params.append('category', filters.category);
      if (filters?.enabled) params.append('enabled', filters.enabled);
      if (filters?.search) params.append('search', filters.search);
      if (filters?.source) params.append('source', filters.source);

      const { data } = await api.get<{ success: boolean; data: IAdminSystemPrompt[]; count: number }>(
        `/api/admin/system-prompts?${params.toString()}`
      );
      return data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Hook to fetch a single system prompt by promptId
 */
export function useSystemPrompt(promptId: string) {
  return useQuery({
    queryKey: ['system-prompt', promptId],
    queryFn: async () => {
      const { data } = await api.get<{ success: boolean; data: IAdminSystemPrompt }>(
        `/api/admin/system-prompts/${promptId}`
      );
      return data;
    },
    enabled: !!promptId,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Hook to update a system prompt
 */
export function useUpdateSystemPrompt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      promptId,
      name,
      description,
      content,
      category,
      tags,
      variables,
      enabled,
    }: {
      promptId: string;
      name?: string;
      description?: string;
      content: string;
      category?: string;
      tags?: string[];
      variables?: string[];
      enabled?: boolean;
    }) => {
      const { data } = await api.put<{ success: boolean; data: IAdminSystemPrompt; message: string }>(
        `/api/admin/system-prompts/${promptId}`,
        {
          name,
          description,
          content,
          category,
          tags,
          variables,
          enabled,
        }
      );
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['system-prompts'] });
      queryClient.invalidateQueries({ queryKey: ['system-prompt', data.data.promptId] });
    },
  });
}

/**
 * Hook to toggle a system prompt's enabled status
 */
export function useToggleSystemPromptEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ promptId, enabled }: { promptId: string; enabled: boolean }) => {
      const { data: currentPromptResponse } = await api.get<{ success: boolean; data: IAdminSystemPrompt }>(
        `/api/admin/system-prompts/${promptId}`
      );
      const currentPrompt = currentPromptResponse.data;

      const { data } = await api.put<{ success: boolean; data: IAdminSystemPrompt; message: string }>(
        `/api/admin/system-prompts/${promptId}`,
        {
          content: currentPrompt.content,
          enabled,
        }
      );
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['system-prompts'] });
      queryClient.invalidateQueries({ queryKey: ['system-prompt', data.data.promptId] });
    },
  });
}

/**
 * Hook to create a new system prompt
 */
export function useCreateSystemPrompt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (promptData: {
      promptId: string;
      name: string;
      description: string;
      content: string;
      category: string;
      tags?: string[];
      variables?: string[];
      enabled?: boolean;
    }) => {
      const { data } = await api.post<{ success: boolean; data: IAdminSystemPrompt; message: string }>(
        '/api/admin/system-prompts',
        promptData
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-prompts'] });
    },
  });
}

/**
 * Request params for testing a system prompt
 */
export interface TestSystemPromptParams {
  promptId: string;
  content: string;
  variables?: Record<string, string>;
  executeWithLLM?: boolean;
}

/**
 * Response from testing a system prompt
 */
export interface TestSystemPromptResponse {
  success: boolean;
  data: {
    renderedContent: string;
    unfilledVariables: string[];
    estimatedTokens: number;
  };
}

/**
 * Hook to test a system prompt with variable substitution
 */
export function useTestSystemPrompt() {
  return useMutation({
    mutationFn: async (params: TestSystemPromptParams) => {
      const { promptId, ...body } = params;
      const { data } = await api.post<TestSystemPromptResponse>(`/api/admin/system-prompts/${promptId}/test`, body);
      return data;
    },
  });
}
