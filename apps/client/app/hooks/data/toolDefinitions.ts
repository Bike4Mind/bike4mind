import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import type { IToolDefinition } from '@client/pages/api/admin/tool-definitions/index';

export type { IToolDefinition };

// Helper to extract error message from axios or generic errors
function getErrorMessage(error: unknown, fallback: string): string {
  // Check for axios error with response data
  if (error && typeof error === 'object' && 'response' in error) {
    const axiosError = error as { response?: { data?: { error?: string } } };
    if (axiosError.response?.data?.error) {
      return axiosError.response.data.error;
    }
  }
  // Check for standard Error object
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

export interface ToolDefinitionsFilters {
  category?: string;
  enabled?: 'true' | 'false' | 'all';
  search?: string;
  source?: 'code' | 'database' | 'all';
  page?: number;
  limit?: number;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface ToolDefinitionsResponse {
  tools: IToolDefinition[];
  total: number;
  categories: string[];
  pagination: PaginationInfo;
}

export interface UpdateToolDefinitionPayload {
  toolId: string;
  description: string;
  shortDescription: string;
  enabled?: boolean;
}

/**
 * Fetch all tool definitions with optional filters and pagination
 */
export function useToolDefinitions(filters?: ToolDefinitionsFilters) {
  return useQuery({
    queryKey: ['tool-definitions', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.category) params.append('category', filters.category);
      if (filters?.enabled) params.append('enabled', filters.enabled);
      if (filters?.search) params.append('search', filters.search);
      if (filters?.source) params.append('source', filters.source);
      if (filters?.page) params.append('page', filters.page.toString());
      if (filters?.limit) params.append('limit', filters.limit.toString());

      const { data } = await api.get<ToolDefinitionsResponse>(`/api/admin/tool-definitions?${params.toString()}`);
      return data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    placeholderData: keepPreviousData, // Keep previous data while loading new filter results
  });
}

/**
 * Fetch a single tool definition by ID
 */
export function useToolDefinition(toolId: string | null) {
  return useQuery({
    queryKey: ['tool-definition', toolId],
    queryFn: async () => {
      if (!toolId) throw new Error('Tool ID is required');
      const { data } = await api.get<IToolDefinition>(`/api/admin/tool-definitions/${toolId}`);
      return data;
    },
    enabled: !!toolId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Update or create a tool definition override
 */
export function useUpdateToolDefinition() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ toolId, description, shortDescription, enabled }: UpdateToolDefinitionPayload) => {
      const { data } = await api.put<IToolDefinition>(`/api/admin/tool-definitions/${toolId}`, {
        description,
        shortDescription,
        enabled,
      });
      return data;
    },
    onSuccess: data => {
      // Invalidate the list query to refresh
      queryClient.invalidateQueries({ queryKey: ['tool-definitions'] });
      // Update the single tool query cache
      queryClient.setQueryData(['tool-definition', data.toolId], data);
      toast.success('Tool definition updated successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, 'Failed to update tool definition'));
    },
  });
}

/**
 * Quick toggle for enabling/disabling a tool
 */
export function useToggleToolEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ toolId, enabled }: { toolId: string; enabled: boolean }) => {
      // First fetch the current tool to get its description
      const { data: currentTool } = await api.get<IToolDefinition>(`/api/admin/tool-definitions/${toolId}`);

      // Then update with the enabled flag
      const { data } = await api.put<IToolDefinition>(`/api/admin/tool-definitions/${toolId}`, {
        description: currentTool.description,
        shortDescription: currentTool.shortDescription,
        enabled,
      });
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['tool-definitions'] });
      queryClient.setQueryData(['tool-definition', data.toolId], data);
      toast.success(`Tool ${data.enabled ? 'enabled' : 'disabled'} successfully`);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, 'Failed to toggle tool status'));
    },
  });
}

/**
 * Delete a tool definition override (revert to code defaults)
 */
export function useDeleteToolDefinition() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (toolId: string) => {
      const { data } = await api.delete<IToolDefinition & { message?: string }>(
        `/api/admin/tool-definitions/${toolId}`
      );
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['tool-definitions'] });
      queryClient.setQueryData(['tool-definition', data.toolId], data);
      toast.success('Override deleted. Tool reverted to code defaults.');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, 'Failed to delete tool definition override'));
    },
  });
}
