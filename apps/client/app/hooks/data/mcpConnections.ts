import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type {
  IMcpConnectionPublic,
  McpApiKeyScheme,
  McpConnectionListEntry,
  McpConnectionTransport,
  McpPresetId,
  McpToolApprovalMode,
  McpToolState,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';

// Client for the custom MCP connector routes (apps/client/pages/api/mcp-connections/**) and their
// platform twins under pages/api/admin/mcp-connections. Request bodies mirror
// apps/client/server/validators/mcpConnectionValidators.ts, which refuses unknown keys.

export const mcpConnectionKeys = {
  all: ['mcpConnections'] as const,
  list: () => [...mcpConnectionKeys.all, 'list'] as const,
  platformList: () => [...mcpConnectionKeys.all, 'platform', 'list'] as const,
  listFor: (scope: McpConnectionScope) =>
    scope === 'platform' ? mcpConnectionKeys.platformList() : mcpConnectionKeys.list(),
};

/** Whose connections a hook manages: the viewer's own, or the platform connectors an admin sets up. */
export type McpConnectionScope = 'user' | 'platform';

const collectionPath = (scope: McpConnectionScope) =>
  scope === 'platform' ? '/api/admin/mcp-connections' : '/api/mcp-connections';

const connectionPath = (scope: McpConnectionScope, id: string) => `${collectionPath(scope)}/${encodeURIComponent(id)}`;

export type McpConnectionAuthInput =
  | { kind: 'none' }
  | { kind: 'oauth' }
  | { kind: 'api_key'; value: string; headerName?: string; scheme?: McpApiKeyScheme };

export interface CreateMcpConnectionInput {
  presetId?: McpPresetId;
  url: string;
  displayName: string;
  description?: string;
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
  /** An empty string clears it. */
  description?: string;
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

/** The viewer's connections and the platform connectors offered to them; empty while the feature is switched off. */
export const useMcpConnections = (options: { enabled?: boolean } = {}) => {
  const impersonating = useAccessToken(s => s.impersonating);
  return useQuery({
    queryKey: mcpConnectionKeys.list(),
    enabled: !impersonating && (options.enabled ?? true),
    queryFn: async () => (await api.get<McpConnectionListEntry[]>('/api/mcp-connections')).data,
    staleTime: 60 * 1000,
  });
};

/** Every platform connector with its admin view; for the admin console only. */
export const usePlatformMcpConnections = () => {
  const impersonating = useAccessToken(s => s.impersonating);
  return useQuery({
    queryKey: mcpConnectionKeys.platformList(),
    enabled: !impersonating,
    queryFn: async () => (await api.get<IMcpConnectionPublic[]>(collectionPath('platform'))).data,
    staleTime: 60 * 1000,
  });
};

const upsert = <T extends { id: string }>(previous: T[] | undefined, entry: T): T[] => {
  const list = previous ?? [];
  return list.some(c => c.id === entry.id) ? list.map(c => (c.id === entry.id ? entry : c)) : [...list, entry];
};

/** Re-reads the scope's list; the viewer's own list also carries a member view of each platform connector. */
function useInvalidateLists(scope: McpConnectionScope) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: mcpConnectionKeys.listFor(scope) }),
      ...(scope === 'platform' ? [queryClient.invalidateQueries({ queryKey: mcpConnectionKeys.list() })] : []),
    ]);
}

/** Writes the returned connection into the list cache, so every view shows the server's answer. */
function useStoreConnection(scope: McpConnectionScope) {
  const queryClient = useQueryClient();
  return (connection: IMcpConnectionPublic) => {
    if (scope === 'platform') {
      queryClient.setQueryData<IMcpConnectionPublic[]>(mcpConnectionKeys.platformList(), previous =>
        upsert(previous, connection)
      );
      void queryClient.invalidateQueries({ queryKey: mcpConnectionKeys.list() });
      return;
    }
    queryClient.setQueryData<McpConnectionListEntry[]>(mcpConnectionKeys.list(), previous =>
      upsert<McpConnectionListEntry>(previous, connection)
    );
  };
}

export const useCreateMcpConnection = (scope: McpConnectionScope = 'user') => {
  const store = useStoreConnection(scope);
  const invalidate = useInvalidateLists(scope);
  return useMutation({
    mutationFn: async (input: CreateMcpConnectionInput) =>
      (await api.post<IMcpConnectionPublic>(collectionPath(scope), input)).data,
    onSuccess: store,
    // A create can persist before it fails, so re-read the list.
    onError: invalidate,
    // The variables hold the submitted key; nothing reads them once the form has its answer.
    gcTime: 0,
  });
};

export const useUpdateMcpConnection = (scope: McpConnectionScope = 'user') => {
  const store = useStoreConnection(scope);
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateMcpConnectionInput) =>
      (await api.patch<IMcpConnectionPublic>(connectionPath(scope, id), body)).data,
    onSuccess: store,
  });
};

export const useRefreshMcpConnectionTools = (scope: McpConnectionScope = 'user') => {
  const store = useStoreConnection(scope);
  const invalidate = useInvalidateLists(scope);
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<RefreshMcpToolsResult>(`${connectionPath(scope, id)}/refresh-tools`)).data,
    onSuccess: result => store(result.connection),
    // A failed discovery is recorded on the connection (status, lastError), so re-read it.
    onError: invalidate,
  });
};

export const useRotateMcpConnectionApiKey = (scope: McpConnectionScope = 'user') => {
  const store = useStoreConnection(scope);
  return useMutation({
    mutationFn: async ({ id, value }: { id: string; value: string }) =>
      (await api.post<IMcpConnectionPublic>(`${connectionPath(scope, id)}/api-key`, { value })).data,
    onSuccess: store,
    gcTime: 0,
  });
};

export const useDeleteMcpConnection = (scope: McpConnectionScope = 'user') => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(connectionPath(scope, id));
      return id;
    },
    onSuccess: id => {
      if (scope === 'platform') {
        queryClient.setQueryData<IMcpConnectionPublic[]>(mcpConnectionKeys.platformList(), previous =>
          (previous ?? []).filter(c => c.id !== id)
        );
        void queryClient.invalidateQueries({ queryKey: mcpConnectionKeys.list() });
        return;
      }
      queryClient.setQueryData<McpConnectionListEntry[]>(mcpConnectionKeys.list(), previous =>
        (previous ?? []).filter(c => c.id !== id)
      );
    },
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
