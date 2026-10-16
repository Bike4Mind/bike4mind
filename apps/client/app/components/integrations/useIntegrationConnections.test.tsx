import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthStrategy, McpServerName } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { clearStoredJupyterConfig, setStoredJupyterConfig } from '@client/app/utils/jupyterBrowserClient';

const h = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  isAdmin: false,
  github: undefined as { connected: boolean } | undefined,
  mcpServers: undefined as Array<{ name: string; enabled: boolean }> | undefined,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: Record<string, unknown>) => unknown) => selector({ currentUser: h.user, isAdmin: h.isAdmin }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useConnectGoogleDrive: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useConnectAtlassian: () => ({ mutate: vi.fn(), isPending: false }),
  useConnectNotion: () => ({ mutate: vi.fn(), isPending: false }),
  useMcpServers: () => ({ data: h.mcpServers }),
}));
vi.mock('@client/app/hooks/data/useGitHubConnectionStatus', () => ({
  useGitHubConnectionStatus: () => ({ data: h.github }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { useIntegrationConnections } from './useIntegrationConnections';

const renderConnections = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useIntegrationConnections(), { wrapper });
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.user = { id: 'u1' };
  h.isAdmin = false;
  h.github = undefined;
  h.mcpServers = undefined;
});

describe('useIntegrationConnections', () => {
  it('reads Google Drive, Slack, inbound email and Okta from the user document', () => {
    h.user = {
      id: 'u1',
      googleDrive: { accessToken: 'x' },
      slackSettings: { slackUserId: 'U123' },
      platformEmailAddress: 'me@mail.example.test',
      authProviders: [{ strategy: AuthStrategy.Okta }],
    };
    const { result } = renderConnections();

    expect(result.current['google-drive']).toEqual({ connected: true });
    expect(result.current.slack).toEqual({ connected: true });
    expect(result.current.email).toEqual({ connected: true });
    expect(result.current.okta).toEqual({ connected: true });
  });

  it('reads nothing as connected for a user with none of it, and for no user at all', () => {
    for (const user of [{ id: 'u1' }, null]) {
      h.user = user;
      const { result, unmount } = renderConnections();
      expect(result.current['google-drive']).toEqual({ connected: false });
      expect(result.current.slack).toEqual({ connected: false });
      expect(result.current.email).toEqual({ connected: false });
      expect(result.current.okta).toEqual({ connected: false });
      expect(result.current.atlassian).toEqual({ connected: false, needsReconnect: false });
      expect(result.current.linkedin).toEqual({ connected: false });
      unmount();
    }
  });

  it('counts a Slack settings block without a Slack user id as not connected', () => {
    h.user = { id: 'u1', slackSettings: { slackUserId: '' } };
    expect(renderConnections().result.current.slack).toEqual({ connected: false });
  });

  it('counts only an Okta provider, not other sign-in providers, as Okta connected', () => {
    h.user = { id: 'u1', authProviders: [{ strategy: AuthStrategy.Google }, { strategy: AuthStrategy.GitHub }] };
    expect(renderConnections().result.current.okta).toEqual({ connected: false });
  });

  it.each(['atlassian', 'notion'] as const)('flags a %s grant that needs reconnecting, and not as connected', key => {
    h.user = { id: 'u1', [`${key}Connect`]: { status: 'needs_reconnect' } };
    expect(renderConnections().result.current[key]).toEqual({ connected: false, needsReconnect: true });
  });

  it.each(['atlassian', 'notion'] as const)('treats a healthy %s grant as connected', key => {
    h.user = { id: 'u1', [`${key}Connect`]: { status: 'connected' } };
    expect(renderConnections().result.current[key]).toEqual({ connected: true, needsReconnect: false });
  });

  it('reads GitHub from the connection probe, which has not answered yet on first render', () => {
    expect(renderConnections().result.current.github).toEqual({ connected: false });

    h.github = { connected: true };
    expect(renderConnections().result.current.github).toEqual({ connected: true });

    h.github = { connected: false };
    expect(renderConnections().result.current.github).toEqual({ connected: false });
  });

  it('reads LinkedIn as connected only when its MCP server is enabled', () => {
    h.mcpServers = [{ name: McpServerName.LinkedIn, enabled: true }];
    expect(renderConnections().result.current.linkedin).toEqual({ connected: true });

    h.mcpServers = [{ name: McpServerName.LinkedIn, enabled: false }];
    expect(renderConnections().result.current.linkedin).toEqual({ connected: false });

    h.mcpServers = [{ name: McpServerName.Github, enabled: true }];
    expect(renderConnections().result.current.linkedin).toEqual({ connected: false });
  });

  describe('Blog publishing, which only an admin can see', () => {
    it('does not ask the server at all for a regular user', () => {
      const { result } = renderConnections();
      expect(api.get).not.toHaveBeenCalled();
      expect(result.current.blog).toEqual({ connected: false });
    });

    it('reads the integration for an admin', async () => {
      h.isAdmin = true;
      vi.mocked(api.get).mockResolvedValue({ data: { connected: true } });
      const { result } = renderConnections();

      await waitFor(() => expect(result.current.blog).toEqual({ connected: true }));
      expect(api.get).toHaveBeenCalledWith('/api/blog-integration');
    });
  });

  describe('Jupyter, whose settings live in this browser rather than on the account', () => {
    afterEach(() => {
      localStorage.clear();
    });

    it('starts from what is stored', () => {
      setStoredJupyterConfig({ serverUrl: 'http://localhost:8888', token: '' });
      expect(renderConnections().result.current.jupyter).toEqual({ connected: true });
    });

    it('follows a save and a disconnect made in this tab, such as from the drawer, without a remount', () => {
      const { result } = renderConnections();
      expect(result.current.jupyter).toEqual({ connected: false });

      act(() => setStoredJupyterConfig({ serverUrl: 'http://localhost:8888', token: 'abc' }));
      expect(result.current.jupyter).toEqual({ connected: true });

      act(() => clearStoredJupyterConfig());
      expect(result.current.jupyter).toEqual({ connected: false });
    });

    it('follows a change made in another tab, which arrives as a storage event', () => {
      const { result } = renderConnections();

      act(() => {
        localStorage.setItem('b4m-jupyter-config', JSON.stringify({ serverUrl: 'http://localhost:8888', token: '' }));
        window.dispatchEvent(new StorageEvent('storage', { key: 'b4m-jupyter-config' }));
      });
      expect(result.current.jupyter).toEqual({ connected: true });

      act(() => {
        localStorage.clear();
        window.dispatchEvent(new StorageEvent('storage', { key: null }));
      });
      expect(result.current.jupyter).toEqual({ connected: false });
    });

    it('stops listening once unmounted', () => {
      const removed = vi.spyOn(window, 'removeEventListener');
      renderConnections().unmount();
      const types = removed.mock.calls.map(([type]) => type);
      expect(types).toContain('storage');
      expect(types).toContain('b4m-jupyter-config-changed');
      removed.mockRestore();
    });
  });
});
