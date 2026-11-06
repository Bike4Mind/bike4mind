import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type {
  IMcpConnectionPublic,
  McpApiKeyScheme,
  McpConnectionTransport,
  McpPresetId,
  McpToolApprovalMode,
  McpToolState,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';

// Client for the custom MCP connector routes (apps/client/pages/api/mcp-connections/**). Request
// bodies mirror apps/client/server/validators/mcpConnectionValidators.ts, which refuses unknown keys.

export const mcpConnectionKeys = {
  all: ['mcpConnections'] as const,
  list: () => [...mcpConnectionKeys.all, 'list'] as const,
};

export type McpConnectionAuthInput =
  | { kind: 'none' }
  | { kind: 'oauth' }
  | { kind: 'api_key'; value: string; headerName?: string; scheme?: McpApiKeyScheme };

export interface CreateMcpConnectionInput {
  presetId?: McpPresetId;
  url: string;
  displayName: string;
  slug?: string;
  transport?: McpConnectionTransport;
  auth: McpConnectionAuthInput;
}

export interface McpToolReviewEntry {
  name: string;
  /** The version the user reviewed; the server answers 409 when the tool changed since. */
  versionHash: string;
  enabled?: boolean;
  approval?: McpToolApprovalMode;
  state?: McpToolState;
}

export interface UpdateMcpConnectionInput {
  id: string;
  displayName?: string;
  enabled?: boolean;
  tools?: McpToolReviewEntry[];
}

export interface RefreshMcpToolsResult {
  connection: IMcpConnectionPublic;
  discovery: { added: string[]; changed: string[]; removed: string[]; dropped: number };
}

/** The server's own message (its routes never echo a submitted secret), else the fallback. */
export function mcpConnectionErrorMessage(error: unknown, fallback: string): string {
  if (!isAxiosError(error)) return fallback;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== 'object') return fallback;
  const { error: message, issues } = data as { error?: unknown; issues?: unknown };
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0] as { message?: unknown };
    if (typeof first?.message === 'string') return first.message;
  }
  return typeof message === 'string' && message ? message : fallback;
}

export const mcpConnectionErrorCode = (error: unknown): string | undefined => {
  if (!isAxiosError(error)) return undefined;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** The viewer's connections; empty while the feature is switched off. */
export const useMcpConnections = (options: { enabled?: boolean } = {}) => {
  const impersonating = useAccessToken(s => s.impersonating);
  return useQuery({
    queryKey: mcpConnectionKeys.list(),
    enabled: !impersonating && (options.enabled ?? true),
    queryFn: async () => (await api.get<IMcpConnectionPublic[]>('/api/mcp-connections')).data,
    staleTime: 60 * 1000,
  });
};

/** Writes the returned connection into the list cache, so every view shows the server's answer. */
function useStoreConnection() {
  const queryClient = useQueryClient();
  return (connection: IMcpConnectionPublic) =>
    queryClient.setQueryData<IMcpConnectionPublic[]>(mcpConnectionKeys.list(), previous => {
      const list = previous ?? [];
      return list.some(c => c.id === connection.id)
        ? list.map(c => (c.id === connection.id ? connection : c))
        : [...list, connection];
    });
}

export const useCreateMcpConnection = () => {
  const store = useStoreConnection();
  return useMutation({
    mutationFn: async (input: CreateMcpConnectionInput) =>
      (await api.post<IMcpConnectionPublic>('/api/mcp-connections', input)).data,
    onSuccess: store,
  });
};

export const useUpdateMcpConnection = () => {
  const store = useStoreConnection();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateMcpConnectionInput) =>
      (await api.patch<IMcpConnectionPublic>(`/api/mcp-connections/${encodeURIComponent(id)}`, body)).data,
    onSuccess: store,
  });
};

export const useRefreshMcpConnectionTools = () => {
  const store = useStoreConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<RefreshMcpToolsResult>(`/api/mcp-connections/${encodeURIComponent(id)}/refresh-tools`)).data,
    onSuccess: result => store(result.connection),
    // A failed discovery is recorded on the connection (status, lastError), so re-read it.
    onError: () => queryClient.invalidateQueries({ queryKey: mcpConnectionKeys.list() }),
  });
};

export const useRotateMcpConnectionApiKey = () => {
  const store = useStoreConnection();
  return useMutation({
    mutationFn: async ({ id, value }: { id: string; value: string }) =>
      (await api.post<IMcpConnectionPublic>(`/api/mcp-connections/${encodeURIComponent(id)}/api-key`, { value })).data,
    onSuccess: store,
  });
};

export const useDeleteMcpConnection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/mcp-connections/${encodeURIComponent(id)}`);
      return id;
    },
    onSuccess: id =>
      queryClient.setQueryData<IMcpConnectionPublic[]>(mcpConnectionKeys.list(), previous =>
        (previous ?? []).filter(c => c.id !== id)
      ),
  });
};

/** Starts sign-in and leaves the page; the provider returns to /integrations/mcp-oauth-callback. */
export const useStartMcpConnectionOAuth = () =>
  useMutation({
    mutationFn: async ({ id, clientId, clientSecret }: { id: string; clientId?: string; clientSecret?: string }) =>
      (
        await api.post<{ authorizationUrl: string }>(
          `/api/mcp-connections/${encodeURIComponent(id)}/oauth/start`,
          clientId ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : {}
        )
      ).data,
    onSuccess: ({ authorizationUrl }) => {
      window.location.href = authorizationUrl;
    },
  });
