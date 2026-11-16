import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useClientConfig, clientConfigQuery } from './clientConfig';
import { usePublicConfig, useServerStatus } from './settings';

const state = vi.hoisted(() => ({ authenticated: true, get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: state.get } }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useIsFullyAuthenticated: () => state.authenticated,
}));

const publicConfig = {
  api_url: 'https://example.test',
  default_theme: 'bike4mind',
  allow_open_registration: false,
  pyodide_base_url: '',
  allow_trusted_devices: true,
  turnstile_site_key: '',
  apple_sign_in_enabled: false,
  support_email: '',
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('web client bootstrap', () => {
  beforeEach(() => {
    state.authenticated = true;
    state.get.mockReset();
  });

  it('shares one authenticated request across transport, public config and status consumers', async () => {
    state.get.mockResolvedValue({
      data: {
        public_config: publicConfig,
        server: { status: 'maintenance' },
        transport: { websocket_url: 'wss://example.test', sse_completions_url: '' },
      },
    });
    const { wrapper, client } = setup();
    const { result } = renderHook(
      () => ({ transport: useClientConfig(), publicConfig: usePublicConfig(), status: useServerStatus() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.status.data?.serverStatus).toBe('maintenance'));
    expect(result.current.transport.data?.transport?.websocket_url).toBe('wss://example.test');
    expect(result.current.publicConfig.data).toEqual({
      apiUrl: 'https://example.test',
      defaultTheme: 'bike4mind',
      allowOpenRegistration: false,
      pyodideBaseUrl: '',
      allowTrustedDevices: true,
      turnstileSiteKey: '',
      appleSignInEnabled: false,
      supportEmail: '',
    });
    expect(state.get).toHaveBeenCalledExactlyOnceWith('/api/v1/client-config');
    client.clear();
  });

  it('keeps pre-login configuration and status available without authenticated bootstrap', async () => {
    state.authenticated = false;
    state.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/public') ? publicConfig : { serverStatus: 'offline' },
    }));
    const { wrapper, client } = setup();
    const { result } = renderHook(() => ({ config: usePublicConfig(), status: useServerStatus() }), { wrapper });
    await waitFor(() => expect(result.current.config.data?.allowTrustedDevices).toBe(true));
    await waitFor(() => expect(result.current.status.data?.serverStatus).toBe('offline'));
    expect(state.get.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/client-config/public',
      '/api/settings/serverStatus',
    ]);
    client.clear();
  });

  it('does not fetch authenticated bootstrap while logged out or mid-MFA', () => {
    state.authenticated = false;
    const { wrapper, client } = setup();
    renderHook(() => useClientConfig(), { wrapper });
    expect(state.get).not.toHaveBeenCalled();
    client.clear();
  });

  it('preserves the projected data shape when callers explicitly refetch', async () => {
    state.get.mockResolvedValue({ data: { public_config: publicConfig, server: { status: 'live' } } });
    const { wrapper, client } = setup();
    const { result } = renderHook(() => ({ config: usePublicConfig(), status: useServerStatus() }), { wrapper });
    await waitFor(() => expect(result.current.config.isSuccess).toBe(true));
    await act(async () => {
      expect((await result.current.config.refetch()).data?.apiUrl).toBe('https://example.test');
      expect((await result.current.status.refetch()).data).toEqual({ serverStatus: 'live' });
    });
    client.clear();
  });

  it('retries transient bootstrap failures but not unauthenticated responses', () => {
    const retry = clientConfigQuery.retry;
    expect(typeof retry).toBe('function');
    if (typeof retry !== 'function') throw new Error('Expected retry predicate');
    expect(retry(0, Object.assign(new Error(), { response: { status: 401 } }))).toBe(false);
    expect(retry(0, new Error('Network Error'))).toBe(true);
    expect(retry(3, new Error('Network Error'))).toBe(false);
  });
});
