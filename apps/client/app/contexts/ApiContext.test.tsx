import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { ApiProvider, api, resetRefreshPromise } from './ApiContext';
import { useAccessToken } from '../hooks/useAccessToken';

// clearClientCaches touches localStorage/IndexedDB; the redirect chain doesn't depend
// on its result (it's fire-and-forget), so stub it to keep the test hermetic.
vi.mock('@client/app/utils/clearClientCaches', () => ({ clearClientCaches: vi.fn().mockResolvedValue(undefined) }));

const make401 = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
    status: 401,
    statusText: 'Unauthorized',
    data: { error: 'Unauthorized', message: 'Authentication required' },
    headers: {},
    config,
  } as AxiosResponse);

const ok = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse =>
  ({ data, status: 200, statusText: 'OK', headers: {}, config }) as AxiosResponse;

describe('ApiProvider 401 interceptor -> login redirect', () => {
  const realLocation = window.location;
  let replace: ReturnType<typeof vi.fn>;
  let realAdapter: AxiosAdapter | undefined;

  beforeEach(() => {
    resetRefreshPromise();
    replace = vi.fn();
    // Replace window.location with a plain stub so the interceptor reads a known,
    // non-public pathname and its window.location.replace is observable. jsdom's
    // real location.replace is unimplemented and would throw.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        pathname: '/new',
        search: '',
        hash: '',
        href: 'http://localhost/new',
        origin: 'http://localhost',
        replace,
      },
    });
    useAccessToken.setState({
      accessToken: 'stale',
      refreshToken: 'refresh',
      expired: false,
      expiredReason: null,
      mfaPending: false,
    });
    realAdapter = api.defaults.adapter as AxiosAdapter | undefined;
  });

  afterEach(() => {
    api.defaults.adapter = realAdapter;
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.clearAllMocks();
  });

  it('clears the session and redirects to /login when the refresh also 401s', async () => {
    // Both the original request AND the refresh return 401, so the refresh can't
    // recover the session - the genuine "stranded user" path.
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => Promise.reject(make401(config))) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    await expect(api.get('/api/mcp-servers')).rejects.toBeTruthy();

    // The whole chain fired: 401 -> markSessionExpired -> window.location.replace.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/login?error=session_expired&redirectTo=%2Fnew');

    const state = useAccessToken.getState();
    expect(state.accessToken).toBeNull();
    expect(state.expired).toBe(true);
    expect(state.expiredReason).toBe('expired');
  });

  it('recovers silently (no redirect) when the refresh succeeds', async () => {
    let dataCalls = 0;
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      if (config.url === '/api/auth/refreshToken') {
        return Promise.resolve(ok(config, { accessToken: 'new-access', refreshToken: 'new-refresh' }));
      }
      dataCalls += 1;
      // First hit 401s (triggers refresh); the post-refresh retry succeeds.
      return dataCalls === 1 ? Promise.reject(make401(config)) : Promise.resolve(ok(config, { ok: true }));
    }) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    const res = await api.get('/api/mcp-servers');

    expect(res.data).toEqual({ ok: true });
    expect(replace).not.toHaveBeenCalled();
    expect(useAccessToken.getState().accessToken).toBe('new-access');
    expect(useAccessToken.getState().expired).toBe(false);
  });
});
