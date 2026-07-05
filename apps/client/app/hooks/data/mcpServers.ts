import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { IMcpServerDocument } from '@bike4mind/common';
import { isAxiosError } from 'axios';
import { useUser } from '@client/app/contexts/UserContext';

// Types
interface AtlassianConnectResponse {
  authUrl?: string;
  state?: string;
  redirectTo?: string; // For pending site selection redirect
}

// Query Keys
export const mcpServerKeys = {
  all: ['mcpServers'] as const,
  lists: () => [...mcpServerKeys.all, 'list'] as const,
  list: (filters?: object) => [...mcpServerKeys.lists(), { ...filters }] as const,
  details: () => [...mcpServerKeys.all, 'detail'] as const,
  detail: (id: string) => [...mcpServerKeys.details(), id] as const,
};

// Hooks
export const useMcpServers = () => {
  return useQuery({
    queryKey: mcpServerKeys.list(),
    queryFn: async (): Promise<IMcpServerDocument[]> => {
      const { data } = await api.get('/api/mcp-servers');
      return data;
    },
    staleTime: 1000 * 60 * 60,
    refetchOnWindowFocus: false,
  });
};

export const useMcpServer = (id: string) => {
  return useQuery({
    queryKey: mcpServerKeys.detail(id),
    queryFn: async (): Promise<IMcpServerDocument> => {
      const { data } = await api.get(`/api/mcp-servers/${id}`);
      return data;
    },
    enabled: !!id,
  });
};

// Notion connection hooks
interface NotionConnectResponse {
  authUrl?: string;
  alreadyConnected?: boolean;
  workspaceName?: string;
}

export const useConnectNotion = () => {
  return useMutation({
    mutationFn: async (): Promise<NotionConnectResponse> => {
      const { data }: { data: NotionConnectResponse } = await api.get('/api/mcp-servers/notion/connect');
      return data;
    },
    onSuccess: (data: NotionConnectResponse) => {
      if (data.alreadyConnected) {
        toast.info(`Already connected to Notion workspace: ${data.workspaceName}`);
        return;
      }
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    },
    onError: error => {
      console.error('Notion connection error:', error);
      const errorMessage = isAxiosError(error)
        ? error.response?.data?.error || error.response?.data?.message || error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      toast.error(`Failed to connect Notion: ${errorMessage}`);
    },
  });
};

export const useDisconnectNotion = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api.delete('/api/mcp-servers/notion/disconnect');
    },
    onMutate: async () => {
      const { currentUser, setCurrentUser } = useUser.getState();
      const previousUser = currentUser;
      if (currentUser) {
        setCurrentUser({
          ...currentUser,
          notionConnect: null,
        });
      }
      return { previousUser };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() });
      queryClient.invalidateQueries({ queryKey: ['pi'] });
      void useUser.getState().refreshUser();
      toast.success('Notion disconnected successfully!');
    },
    onError: (error, _vars, context) => {
      console.error('Notion disconnection error:', error);
      if (context?.previousUser) {
        useUser.getState().setCurrentUser(context.previousUser);
      }
      toast.error(`Failed to disconnect Notion: ${error.message}`);
    },
  });
};

// Notion settings hooks
interface AllowedPage {
  id: string;
  title: string;
  type: 'page' | 'database';
  access: 'read' | 'readwrite';
}

interface NotionSettingsPayload {
  writeEnabled?: boolean;
  rootPageId?: string | null;
  accessMode?: 'all' | 'selected';
  allowedPages?: AllowedPage[];
  excludedPageIds?: string[];
}

export const useUpdateNotionSettings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (settings: NotionSettingsPayload): Promise<void> => {
      await api.patch('/api/mcp-servers/notion/settings', settings);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      void useUser.getState().refreshUser();
    },
    onError: error => {
      console.error('Notion settings update error:', error);
      const errorMessage = isAxiosError(error)
        ? error.response?.data?.error || error.response?.data?.message || error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      toast.error(`Failed to update Notion settings: ${errorMessage}`);
    },
  });
};

export const useConnectAtlassian = () => {
  return useMutation({
    mutationFn: async (): Promise<AtlassianConnectResponse> => {
      // Get auth URL or redirect destination
      const { data }: { data: AtlassianConnectResponse } = await api.get('/api/mcp-servers/atlassian/connect');
      return data;
    },
    onSuccess: async (data: AtlassianConnectResponse) => {
      // If there's a pending site selection, redirect to that page
      if (data.redirectTo) {
        window.location.href = data.redirectTo;
        return;
      }
      // Otherwise redirect to Atlassian OAuth
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    },
    onError: error => {
      console.error('Atlassian connection error:', error);
      const errorMessage = isAxiosError(error)
        ? error.response?.data?.error || error.response?.data?.message || error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      toast.error(`Failed to connect Atlassian: ${errorMessage}`);
    },
  });
};

export const useDisconnectAtlassian = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api.delete('/api/mcp-servers/atlassian/disconnect');
    },
    onMutate: async () => {
      const { currentUser, setCurrentUser } = useUser.getState();
      if (currentUser) {
        setCurrentUser({
          ...currentUser,
          atlassianConnect: null,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() });
      queryClient.invalidateQueries({ queryKey: ['pi'] });
      void useUser.getState().refreshUser();
      toast.success('Atlassian disconnected successfully!');
    },
    onError: error => {
      console.error('Atlassian disconnection error:', error);
      toast.error(`Failed to disconnect Atlassian: ${error.message}`);
    },
  });
};

export const useFinalizeAtlassian = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (resourceId: string): Promise<void> => {
      await api.post('/api/mcp-servers/atlassian/finalize', { resourceId });
    },
    onSuccess: async (_data, resourceId) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() });

      await useUser.getState().refreshUser();

      toast.success('Atlassian site connected successfully!');

      window.location.href = '/profile?tab=integrations&atlassian=connected';
    },
    onError: error => {
      console.error('Atlassian finalization error:', error);
      const errorMessage = isAxiosError(error)
        ? error.response?.data?.error || error.response?.data?.message || error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      toast.error(`Failed to connect Atlassian site: ${errorMessage}`);
    },
  });
};
