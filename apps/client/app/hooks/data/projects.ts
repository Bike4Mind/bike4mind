import { IProject, IProjectDocument, ISessionDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError, isAxiosError } from 'axios';
import { toast } from 'sonner';
import { generateMockProjects } from '@client/app/mocks/mockProjects';

// Set true to use mock projects for UI testing
const USE_MOCK_PROJECTS = false;

export const useGetJoinedProjects = (userId: string) => {
  return useQuery({
    queryKey: ['joined-projects', userId],
    queryFn: async () => {
      try {
        if (USE_MOCK_PROJECTS && userId) {
          const realProjects = await api
            .get<IProjectDocument[]>(`/api/users/${userId}/projects`)
            .then(res => res.data)
            .catch(() => []);

          const mockProjects = generateMockProjects(userId, 3);
          const combined = [...realProjects, ...mockProjects];
          return combined;
        }

        const { data } = await api.get<IProjectDocument[]>(`/api/users/${userId}/projects`);
        return data;
      } catch (error) {
        console.warn('Error fetching joined projects:', error);
        return [];
      }
    },
    enabled: !!userId,
  });
};

export const useCreateProject = (callback?: { onSuccess?: () => void; onError?: (error: Error) => void }) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      project: Pick<IProject, 'name' | 'description'> & { sessionIds?: string[]; fileIds?: string[] }
    ) => {
      const response = await api.post<IProjectDocument>('/api/projects', project);
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      updateAllQueryData(queryClient, 'projects', 'write', project, {
        keysAllowedToCreate: [['projects', 'search']],
      });

      toast.success('Project created successfully');
      callback?.onSuccess?.();
    },
    onError: error => {
      if (error instanceof AxiosError) {
        toast.error(error.response?.data?.error ?? 'Failed to create project');
      } else {
        toast.error('Failed to create project');
      }
      callback?.onError?.(error);
    },
  });
};

export const useSearchProjects = (
  search: string,
  filters: { favorite?: boolean },
  orderBy: { by: 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' },
  options?: { enabled?: boolean }
) => {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: ['projects', 'search', { search, filters, orderBy }],
    initialPageParam: { page: 1 },
    queryFn: async params => {
      const { page = 1 } = params.pageParam || {};
      try {
        // Progressive loading: smaller first batch for faster initial render
        const limit = page === 1 ? 4 : 8;

        const response = await api.get<{ data: IProjectDocument[]; hasMore: boolean }>('/api/projects', {
          params: {
            search,
            filters,
            pagination: {
              page,
              limit,
            },
            orderBy,
          },
        });

        response.data.data.forEach(project => {
          queryClient.setQueryData(['projects', project.id], project);
        });

        return response.data;
      } catch (e) {
        return { data: [], hasMore: false };
      }
    },
    getNextPageParam: (lastPage, _allPages, { page }) => {
      if (lastPage.hasMore) {
        return { page: page + 1 };
      }
      return undefined;
    },
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: false,
    retry: 1, // Reduce retry attempts for faster failure handling
  });
};

export const useAddSessionsToProject = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { projectId: string; sessionIds: string[] }) => {
      const { projectId, sessionIds } = params;
      const response = await api.post<ISessionDocument[]>(`/api/projects/${projectId}/sessions`, { sessionIds });
      queryClient.invalidateQueries({ queryKey: ['sessions', 'projects', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      return response.data;
    },
    onSuccess: (value: ISessionDocument[]) => {
      queryClient.invalidateQueries({ queryKey: ['projects', 'search'] });
      queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own'] });
      toast.success('Sessions added to project successfully');
      callbacks?.onSuccess?.();
    },
    onError: () => {
      toast.error('Failed to add sessions to project');
      callbacks?.onError?.();
    },
  });
};

export const useAddFilesToProject = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { projectId: string; fileIds: string[] }) => {
      const { projectId, fileIds } = params;
      const response = await api.post<IProjectDocument>(`/api/projects/${projectId}/files`, { fileIds });
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      updateAllQueryData(queryClient, 'projects', 'write', project);
      queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own'] });

      toast.success('Files added to project successfully');
      callbacks?.onSuccess?.();
    },
    onError: () => {
      toast.error('Failed to add files to project');
      callbacks?.onError?.();
    },
  });
};

export const useGetProject = (projectId?: string) => {
  return useQuery({
    queryKey: ['projects', projectId],
    queryFn: async () => {
      const response = await api.get<IProjectDocument>(`/api/projects/${projectId}`);
      return response.data;
    },
    enabled: !!projectId,
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
  });
};

export const useDeleteProject = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (projectId: string) => {
      await api.delete(`/api/projects/${projectId}`);
    },
    onSuccess: (_data, projectId) => {
      updateAllQueryData(queryClient, 'projects', 'delete', { id: projectId });
      toast.success('Project deleted successfully');
      callbacks?.onSuccess?.();
    },
    onError: () => {
      toast.error('Failed to delete project');
      callbacks?.onError?.();
    },
  });
};

export const useUpdateProject = (callbacks?: {
  onSuccess?: (project: IProjectDocument) => void;
  onError?: () => void;
}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (project: IProjectDocument) => {
      const response = await api.put(`/api/projects/${project.id}`, project);
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      updateAllQueryData(queryClient, 'projects', 'write', project);
      toast.success('Project updated successfully');
      callbacks?.onSuccess?.(project);
    },
    onError: () => {
      toast.error('Failed to update project');
      callbacks?.onError?.();
    },
  });
};

export const useRemoveSessionsFromProject = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { projectId: string; sessionIds: string[] }) => {
      const { projectId, sessionIds } = params;
      const response = await api.delete<IProjectDocument>(`/api/projects/${projectId}/sessions`, {
        data: { sessionIds },
      });
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      queryClient.invalidateQueries({ queryKey: ['projects', project.id] });
      queryClient.invalidateQueries({ queryKey: ['projects', 'search'] });
      queryClient.invalidateQueries({ queryKey: ['sessions', 'projects', project.id] });
      queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
      updateAllQueryData(queryClient, 'projects', 'write', project);
      toast.success('Sessions removed from project successfully');
      callbacks?.onSuccess?.();
    },
    onError: () => {
      toast.error('Failed to remove sessions from project');
      callbacks?.onError?.();
    },
  });
};

export const useRemoveFilesFromProject = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { projectId: string; fileIds: string[] }) => {
      const { projectId, fileIds } = params;
      const response = await api.delete<IProjectDocument>(`/api/projects/${projectId}/files`, {
        data: { fileIds },
      });
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own'] });
      queryClient.invalidateQueries({ queryKey: ['projects', project.id, 'files'] });
      updateAllQueryData(queryClient, 'projects', 'write', project);

      toast.success('Files removed from project successfully');
      callbacks?.onSuccess?.();
    },
    onError: e => {
      if (isAxiosError(e)) {
        toast.error(e.response?.data?.error ?? 'Failed to remove files from project');
      } else {
        toast.error('Failed to remove files from project');
      }
      callbacks?.onError?.();
    },
  });
};

/**
 * Remove references to no-longer-existing files from the current user's projects,
 * and revoke project-user access to them.
 *
 * @param callbacks - Optional success/error callbacks
 * @returns Mutation accepting fileIds to filter projects
 */
export const useRemoveNonExistentFiles = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileIds: string[]) => {
      const response = await api.delete<{
        message: string;
        updatedProjects: IProjectDocument[];
      }>('/api/projects/removeNonExistintFiles', {
        data: { fileIds },
      });
      return response.data;
    },
    onSuccess: async data => {
      data.updatedProjects.forEach(project => {
        queryClient.invalidateQueries({ queryKey: ['projects', project.id] });
      });

      queryClient.invalidateQueries({ queryKey: ['projects', 'search'] });
      queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own'] });

      toast.success('Non-existent files removed from projects successfully');
      callbacks?.onSuccess?.();
    },
    onError: e => {
      if (isAxiosError(e)) {
        toast.error(e.response?.data?.error ?? 'Failed to clean up project files');
      } else {
        toast.error('Failed to clean up project files');
      }
      callbacks?.onError?.();
    },
  });
};

export const useAddSystemPromptsToProject = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { projectId: string; fileIds: string[] }) => {
      const { projectId, fileIds } = params;
      const response = await api.post<IProjectDocument>(`/api/projects/${projectId}/systemPrompts`, { fileIds });
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      updateAllQueryData(queryClient, 'projects', 'write', project);
      queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own'] });
      toast.success('System prompts added successfully');
      callbacks?.onSuccess?.();
    },
    onError: () => {
      toast.error('Failed to add system prompts');
      callbacks?.onError?.();
    },
  });
};

export const useToggleSystemPrompt = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { projectId: string; fileId: string }) => {
      const { projectId, fileId } = params;
      const project = queryClient.getQueryData<IProjectDocument>(['projects', projectId]);
      if (project) {
        // Optimistic update
        const indexToBeUpdated = project?.systemPrompts.findIndex(prompt => prompt.fileId === fileId);
        project.systemPrompts[indexToBeUpdated].enabled = !project.systemPrompts[indexToBeUpdated].enabled;
        queryClient.setQueryData(['projects', projectId], project);
      }

      const response = await api.post<IProjectDocument>(`/api/projects/${projectId}/systemPrompts/toggle`, { fileId });
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      updateAllQueryData(queryClient, 'projects', 'write', project);
      toast.success('System prompt toggled successfully');
      callbacks?.onSuccess?.();
    },
    onError: () => {
      toast.error('Failed to toggle system prompt');
      callbacks?.onError?.();
    },
  });
};

export const useRemoveSystemPromptsFromProject = (callbacks?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { projectId: string; fileIds: string[] }) => {
      const { projectId, fileIds } = params;
      const response = await api.delete<IProjectDocument>(`/api/projects/${projectId}/systemPrompts`, {
        data: { fileIds },
      });
      return response.data;
    },
    onSuccess: (project: IProjectDocument) => {
      updateAllQueryData(queryClient, 'projects', 'write', project);
      queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own'] });
      toast.success('System prompts removed successfully');
      callbacks?.onSuccess?.();
    },
    onError: e => {
      if (isAxiosError(e)) {
        toast.error(e.response?.data?.error ?? 'Failed to remove system prompts');
      } else {
        toast.error('Failed to remove system prompts');
      }
      callbacks?.onError?.();
    },
  });
};

export const useLeaveProject = (callback?: { onSuccess?: () => void; onError?: () => void }) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ projectId, userId }: { projectId: string; userId?: string }) => {
      await api.delete(`/api/projects/${projectId}/members`, { data: { userId } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
      callback?.onSuccess?.();
    },
    onError: e => {
      if (callback?.onError) {
        callback?.onError();
      } else {
        toast.error(isAxiosError(e) ? e.response?.data?.error : 'Failed to leave project');
      }
    },
  });
};
