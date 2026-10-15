import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
