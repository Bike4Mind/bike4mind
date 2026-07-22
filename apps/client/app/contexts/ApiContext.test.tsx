import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { ApiProvider, api, resetRefreshPromise, resetRedirectingGuard } from './ApiContext';
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

// A mfaPending 401: the full-auth middleware rejects every non-allowlisted request
// during the login mfaPending window with this exact { mfaPending: true } marker.
const makeMfaPending401 = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
    status: 401,
    statusText: 'Unauthorized',
    data: { error: 'MFA setup or verification required.', mfaPending: true },
    headers: {},
    config,
  } as AxiosResponse);

const ok = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse =>
  ({ data, status: 200, statusText: 'OK', headers: {}, config }) as AxiosResponse;

// A non-auth failure (e.g. 503 from a cold/hanging refresh Lambda) - transient, NOT a
// revocation, so the interceptor must reject-and-retry rather than force a logout.
const makeStatus = (config: InternalAxiosRequestConfig, status: number): AxiosError =>
  new AxiosError(`Error ${status}`, 'ERR_BAD_RESPONSE', config, {}, {
    status,
    statusText: 'Error',
    data: {},
    headers: {},
    config,
  } as AxiosResponse);

// A bare network error carries no response (isAxiosError true, response undefined) - also transient.
const makeNetworkError = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError('Network Error', 'ERR_NETWORK', config, {});

describe('ApiProvider 401 interceptor -> login redirect', () => {
  const realLocation = window.location;
  let replace: ReturnType<typeof vi.fn>;
  let realAdapter: AxiosAdapter | undefined;

  beforeEach(() => {
    resetRefreshPromise();
    resetRedirectingGuard();
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

  it('does NOT log out when the refresh fails with a transient 5xx (cold Lambda / outage)', async () => {
    // The original request 401s (token expired) so a refresh is attempted, but the
    // refresh endpoint returns 503 - a transient outage, not a rejected refresh token.
    // Logging the user out here would be a false positive; this is the exact deploy-time
    // correlation the WebsocketContext probe can trigger through this interceptor.
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      if (config.url === '/api/auth/refreshToken') return Promise.reject(makeStatus(config, 503));
      return Promise.reject(make401(config));
    }) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    await expect(api.get('/api/mcp-servers')).rejects.toBeTruthy();

    // Transient - no redirect, session preserved so the client keeps retrying.
    expect(replace).not.toHaveBeenCalled();
    const state = useAccessToken.getState();
    expect(state.accessToken).toBe('stale');
    expect(state.expired).toBe(false);
  });

  it('does NOT log out when the refresh fails with a bare network error (transient)', async () => {
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      if (config.url === '/api/auth/refreshToken') return Promise.reject(makeNetworkError(config));
      return Promise.reject(make401(config));
    }) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    await expect(api.get('/api/mcp-servers')).rejects.toBeTruthy();

    expect(replace).not.toHaveBeenCalled();
    expect(useAccessToken.getState().accessToken).toBe('stale');
    expect(useAccessToken.getState().expired).toBe(false);
  });

  it('redirects to /login on a 401 when the session is already marked expired (no refresh attempted)', async () => {
    // Before the fix, this branch silently rejected with no redirect - the "flood of
    // 401s with no prompt" bug. It must now resolve to the same clean sign-out as the
    // refresh-fails path, without ever attempting a refresh (no refreshToken call).
    useAccessToken.setState({ expired: true, expiredReason: null, accessToken: null, refreshToken: null });
    let refreshCalls = 0;
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      if (config.url === '/api/auth/refreshToken') refreshCalls += 1;
      return Promise.reject(make401(config));
    }) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    await expect(api.get('/api/mcp-servers')).rejects.toBeTruthy();

    expect(refreshCalls).toBe(0);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/login?error=session_expired&redirectTo=%2Fnew');
    expect(useAccessToken.getState().expiredReason).toBe('expired');
  });

  it('redirects to /login on a 401 with no refresh token at all', async () => {
    useAccessToken.setState({ expired: false, expiredReason: null, accessToken: 'stale', refreshToken: null });
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => Promise.reject(make401(config))) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    await expect(api.get('/api/mcp-servers')).rejects.toBeTruthy();

    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does NOT redirect on a 401 during mfaPending, even with no refresh token', async () => {
    // During mfaPending the login stage issues no refresh token by design - a
    // non-allowlisted 401 here means the user is mid-MFA-setup, not locked out.
    // Force-redirecting them to /login would break the MFA flow.
    useAccessToken.setState({
      expired: false,
      expiredReason: null,
      accessToken: 'mfa-token',
      refreshToken: null,
      mfaPending: true,
    });
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => Promise.reject(make401(config))) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    await expect(api.get('/api/mcp-servers')).rejects.toBeTruthy();

    expect(replace).not.toHaveBeenCalled();
    // No forced teardown either - mfaPending session state must be left alone.
    expect(useAccessToken.getState().mfaPending).toBe(true);
  });

  it('does NOT console-log a mfaPending 401 (expected mid-MFA rejection), but still logs a normal 401 (#804)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // mfaPending session: token present, no refresh token - the interceptor's 401
    // branch no-ops the redirect, and the logging block must stay silent.
    useAccessToken.setState({
      expired: false,
      expiredReason: null,
      accessToken: 'mfa-token',
      refreshToken: null,
      mfaPending: true,
    });
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(makeMfaPending401(config))) as AxiosAdapter;

    await expect(api.get('/api/agents')).rejects.toBeTruthy();
    expect(errorSpy).not.toHaveBeenCalled();

    // A plain 401 (no mfaPending marker) is a real error and must still be logged.
    useAccessToken.setState({ accessToken: null, refreshToken: null, expired: true, mfaPending: false });
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => Promise.reject(make401(config))) as AxiosAdapter;
    await expect(api.get('/api/agents')).rejects.toBeTruthy();
    expect(errorSpy).toHaveBeenCalledWith('Axios Error:', expect.anything());

    errorSpy.mockRestore();
  });

  it('fires exactly one redirect when a burst of concurrent 401s are all unrecoverable', async () => {
    useAccessToken.setState({ expired: true, expiredReason: null, accessToken: null, refreshToken: null });
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => Promise.reject(make401(config))) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    const results = await Promise.allSettled([
      api.get('/api/mcp-servers'),
      api.get('/api/models'),
      api.get('/api/settings/fetch'),
    ]);

    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does not redirect when the pathname is already public', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        pathname: '/login',
        search: '',
        hash: '',
        href: 'http://localhost/login',
        origin: 'http://localhost',
        replace,
      },
    });
    useAccessToken.setState({ expired: true, expiredReason: null, accessToken: null, refreshToken: null });
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => Promise.reject(make401(config))) as AxiosAdapter;

    render(
      <ApiProvider>
        <div />
      </ApiProvider>
    );

    // The interceptor's own top-level isPublicPath gate skips the whole 401 branch.
    await expect(api.get('/api/mcp-servers')).rejects.toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  // --- #627: interceptors must be live BEFORE ApiProvider mounts ---
  // The auth interceptors are registered at module scope, not in ApiProvider's
  // useEffect. This is what closes the cold-load race: a query gated on the
  // synchronously-rehydrated persisted `currentUser` (e.g. useGetOwnSessions) can
  // fire through `api` on the very first render, before any effect has run. If the
  // interceptors only existed after mount, that request would go out with no token,
  // 401, and never refresh-retry - leaving the sidebar/UI empty until a manual
  // reload. These two tests deliberately do NOT render <ApiProvider>, exercising
  // exactly that pre-mount window; they fail on the old useEffect-registered code.

  it('attaches the bearer token to a request fired WITHOUT mounting ApiProvider (#627)', async () => {
    useAccessToken.setState({ accessToken: 'tok-abc', refreshToken: 'refresh', expired: false, mfaPending: false });
    let seenAuth: string | undefined;
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      seenAuth = config.headers?.Authorization as string | undefined;
      return Promise.resolve(ok(config, { ok: true }));
    }) as AxiosAdapter;

    // No render(<ApiProvider>) - this is the cold-load window before any effect runs.
    const res = await api.get('/api/sessions');

    expect(res.data).toEqual({ ok: true });
    expect(seenAuth).toBe('Bearer tok-abc');
  });

  it('refresh-retries a 401 fired WITHOUT mounting ApiProvider, so the cold-load query self-heals (#627)', async () => {
    useAccessToken.setState({ accessToken: 'stale', refreshToken: 'refresh', expired: false, mfaPending: false });
    let dataCalls = 0;
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      if (config.url === '/api/auth/refreshToken') {
        return Promise.resolve(ok(config, { accessToken: 'new-access', refreshToken: 'new-refresh' }));
      }
      dataCalls += 1;
      // First call 401s (token stale); the post-refresh retry succeeds with real data.
      return dataCalls === 1
        ? Promise.reject(make401(config))
        : Promise.resolve(ok(config, { data: [{ id: 's1' }], hasMore: false }));
    }) as AxiosAdapter;

    // Again, no ApiProvider mount.
    const res = await api.get('/api/sessions');

    expect(res.data).toEqual({ data: [{ id: 's1' }], hasMore: false });
    expect(replace).not.toHaveBeenCalled();
    expect(useAccessToken.getState().accessToken).toBe('new-access');
  });
});
