import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useConfig, usePublicConfig, useServerStatus } from './settings';

const state = vi.hoisted(() => ({ authenticated: true, get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: state.get } }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useIsFullyAuthenticated: () => state.authenticated,
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('legacy web bootstrap boundaries', () => {
  beforeEach(() => {
    state.authenticated = true;
    state.get.mockReset();
  });

  it.each([true, false])('keeps public config and status independent of authentication (%s)', async authenticated => {
    state.authenticated = authenticated;
    state.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('serverConfigPublic') ? { allowTrustedDevices: true } : { serverStatus: 'maintenance' },
    }));
    const { wrapper, client } = setup();
    const { result } = renderHook(() => ({ config: usePublicConfig(), status: useServerStatus() }), { wrapper });
    await waitFor(() => expect(result.current.config.data?.allowTrustedDevices).toBe(true));
    await waitFor(() => expect(result.current.status.data?.serverStatus).toBe('maintenance'));
    expect(state.get.mock.calls.map(([url]) => url)).toEqual([
      '/api/settings/serverConfigPublic',
      '/api/settings/serverStatus',
    ]);
    client.clear();
  });

  it('resolves transport without requesting the model catalog or client-config', async () => {
    state.get.mockImplementation(async (url: string) => {
      if (url !== '/api/settings/serverConfig') throw new Error('Catalog unavailable');
      return { data: { websocketUrl: 'wss://example.test' } };
    });
    const { wrapper, client } = setup();
    const { result } = renderHook(() => useConfig(), { wrapper });
    await waitFor(() => expect(result.current.data?.websocketUrl).toBe('wss://example.test'));
    expect(state.get).toHaveBeenCalledExactlyOnceWith('/api/settings/serverConfig');
    client.clear();
  });

  it('does not fetch authenticated transport while logged out or mid-MFA', () => {
    state.authenticated = false;
    const { wrapper, client } = setup();
    renderHook(() => useConfig(), { wrapper });
    expect(state.get).not.toHaveBeenCalled();
    client.clear();
  });
});
