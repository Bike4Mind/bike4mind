import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

vi.mock('../utils/Logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const mockGetAuthTokens = vi.fn();
const mockClearAuthTokens = vi.fn();
vi.mock('../storage/ConfigStore', () => ({
  ConfigStore: class {
    getAuthTokens = mockGetAuthTokens;
    setAuthTokens = vi.fn();
    clearAuthTokens = mockClearAuthTokens;
    isAuthenticated = vi.fn();
  },
}));

const mockRefreshToken = vi.fn();
vi.mock('./OAuthClient', () => ({
  OAuthClient: class {
    refreshToken = mockRefreshToken;
  },
}));

import { ApiClient, DEFAULT_API_TIMEOUT_MS, NotAuthenticatedError, SessionRevokedError } from './ApiClient';

const make401 = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
    status: 401,
    statusText: 'Unauthorized',
    data: {},
    headers: {},
    config,
  } as AxiosResponse);

const ok = (config: InternalAxiosRequestConfig): AxiosResponse =>
  ({ data: { id: 'user-1' }, status: 200, statusText: 'OK', headers: {}, config }) as AxiosResponse;

// A refresh-endpoint rejection carrying an HTTP status (e.g. 400 invalid_grant / 401), so
// the interceptor can tell a genuine revocation from a transient (5xx / network) outage.
const refreshHttpError = (status: number): AxiosError =>
  new AxiosError('Refresh rejected', 'ERR_BAD_REQUEST', undefined, {}, {
    status,
    statusText: 'Bad Request',
    data: { error: 'invalid_grant' },
    headers: {},
    config: {} as InternalAxiosRequestConfig,
  } as AxiosResponse);

/** Await a promise expected to reject and return the Error it threw, typed. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('Expected the request to reject');
}

describe('ApiClient.checkSessionValid', () => {
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient('http://localhost:3000');
    // Expired-but-present token so the interceptor's "fresh token, skip refresh" shortcut
    // does not fire and the refresh path actually runs.
    mockGetAuthTokens.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'user-1',
    });
  });

  it('returns true when the session is valid (request succeeds)', async () => {
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.resolve(ok(config))) as AxiosAdapter;

    expect(await client.checkSessionValid()).toBe(true);
  });

  it('returns true when a fresh token retry succeeds (transient 401, not a revocation)', async () => {
    let calls = 0;
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      calls += 1;
      return calls === 1 ? Promise.reject(make401(config)) : Promise.resolve(ok(config));
    }) as AxiosAdapter;
    mockRefreshToken.mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh2', expires_in: 3600 });

    expect(await client.checkSessionValid()).toBe(true);
  });

  it('returns false when refresh is rejected with 400 (invalid_grant) - a genuine revocation', async () => {
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockRejectedValue(refreshHttpError(400));

    expect(await client.checkSessionValid()).toBe(false);
  });

  it('returns false when refresh is rejected with 401 - a genuine revocation', async () => {
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockRejectedValue(refreshHttpError(401));

    expect(await client.checkSessionValid()).toBe(false);
  });

  it('returns false when a request still 401s after a SUCCESSFUL refresh - a definitive revocation', async () => {
    // The refresh itself succeeds, but the retried request 401s again. That is the second
    // SessionRevokedError throw site (interceptor's already-retried branch): a 401 surviving a
    // fresh token is definitive, not transient.
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh2', expires_in: 3600 });

    expect(await client.checkSessionValid()).toBe(false);
  });

  it('passes a provider-key 401 on the post-refresh retry through, not as a revoked session', async () => {
    // The refreshed token is accepted, but the route 401s for a missing provider key; that
    // must reach mapApiError intact rather than become "run /login".
    let calls = 0;
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      calls += 1;
      if (calls === 1) return Promise.reject(make401(config));
      return Promise.reject(
        new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
          status: 401,
          statusText: 'Unauthorized',
          data: { error: 'No TTS provider is configured', errorCode: 'provider_not_configured' },
          headers: {},
          config,
        } as AxiosResponse)
      );
    }) as AxiosAdapter;
    mockRefreshToken.mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh2', expires_in: 3600 });

    const err = await rejection(client.post('/api/ai/tts', { text: 'hi' }));

    expect(err).not.toBeInstanceOf(SessionRevokedError);
    expect(err).toBeInstanceOf(AxiosError);
    expect((err as AxiosError).response?.data).toMatchObject({ errorCode: 'provider_not_configured' });
    expect(mockClearAuthTokens).not.toHaveBeenCalled();
  });

  it('returns true when refresh fails with a 5xx - a transient outage, not a revocation', async () => {
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockRejectedValue(refreshHttpError(503));

    expect(await client.checkSessionValid()).toBe(true);
  });

  it('returns true when refresh fails with a bare network error - transient, not a revocation', async () => {
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockRejectedValue(new Error('Network Error'));

    expect(await client.checkSessionValid()).toBe(true);
  });

  it('returns true on a non-auth error (network blip) - treated as transient, not revoked', async () => {
    client.getAxiosInstance().defaults.adapter = (() => Promise.reject(new Error('Network Error'))) as AxiosAdapter;

    expect(await client.checkSessionValid()).toBe(true);
  });
});

describe('ApiClient no-credential 401', () => {
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient('http://localhost:3000');
  });

  it('throws NotAuthenticatedError (not "expired") when a 401 arrives with no stored tokens', async () => {
    // No API key and no stored tokens: there is nothing to refresh, so this must be a
    // distinct "no credential" outcome, not the refresh-failure "expired" copy.
    mockGetAuthTokens.mockResolvedValue(null);
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;

    const err = await rejection(client.get('/api/sessions'));

    expect(err).toBeInstanceOf(NotAuthenticatedError);
    expect(err.name).toBe('NotAuthenticatedError');
    expect(err.message).toContain('Authentication failed');
    expect(err.message).not.toContain('expired');
    expect(mockRefreshToken).not.toHaveBeenCalled();
  });

  it('still reports "Authentication expired" when a stored token fails to refresh', async () => {
    // Guards the path we must not change: a stored, expired token whose refresh is
    // rejected stays a SessionRevokedError with the original wording.
    mockGetAuthTokens.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'user-1',
    });
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockRejectedValue(refreshHttpError(400));

    const err = await rejection(client.get('/api/sessions'));

    expect(err).toBeInstanceOf(SessionRevokedError);
    expect(err.message).toContain('Authentication expired');
  });

  it('is not treated as a revocation when there are no tokens (checkSessionValid unchanged)', async () => {
    mockGetAuthTokens.mockResolvedValue(null);
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;

    expect(await client.checkSessionValid()).toBe(true);
  });

  it('reports no-credential (not expired) on the call after a failed refresh cleared the tokens', async () => {
    let stored: unknown = {
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'user-1',
    };
    mockGetAuthTokens.mockImplementation(async () => stored);
    mockClearAuthTokens.mockImplementation(async () => {
      stored = null;
    });
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockRejectedValue(refreshHttpError(400));

    try {
      expect(await rejection(client.get('/api/sessions'))).toBeInstanceOf(SessionRevokedError);
      expect(mockClearAuthTokens).toHaveBeenCalled();

      const second = await rejection(client.get('/api/sessions'));

      expect(second).toBeInstanceOf(NotAuthenticatedError);
      expect(second.message).not.toContain('expired');
    } finally {
      mockGetAuthTokens.mockReset();
      mockClearAuthTokens.mockReset();
    }
  });
});

describe('ApiClient API key auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects x-api-key and never a Bearer token when an API key is set', async () => {
    const client = new ApiClient('http://localhost:3000', undefined, 'b4m_live_secret');
    let seen: InternalAxiosRequestConfig | undefined;
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      seen = config;
      return Promise.resolve(ok(config));
    }) as AxiosAdapter;

    await client.get('/api/sessions');

    expect(seen?.headers['x-api-key']).toBe('b4m_live_secret');
    expect(seen?.headers.Authorization).toBeUndefined();
    // The stored-JWT path must not be consulted at all when an API key is present.
    expect(mockGetAuthTokens).not.toHaveBeenCalled();
  });

  it('does not attempt a token refresh on 401 when an API key is set', async () => {
    const client = new ApiClient('http://localhost:3000', undefined, 'b4m_live_secret');
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;

    await expect(client.get('/api/sessions')).rejects.toBeInstanceOf(AxiosError);
    expect(mockRefreshToken).not.toHaveBeenCalled();
  });

  it('applies the generous default request timeout so a hung backend cannot wedge a caller forever', () => {
    const client = new ApiClient('http://localhost:3000');
    expect(client.getAxiosInstance().defaults.timeout).toBe(DEFAULT_API_TIMEOUT_MS);
  });

  it('honors a B4M_API_TIMEOUT_MS override', () => {
    const prev = process.env.B4M_API_TIMEOUT_MS;
    process.env.B4M_API_TIMEOUT_MS = '1234';
    try {
      const client = new ApiClient('http://localhost:3000');
      expect(client.getAxiosInstance().defaults.timeout).toBe(1234);
    } finally {
      if (prev === undefined) delete process.env.B4M_API_TIMEOUT_MS;
      else process.env.B4M_API_TIMEOUT_MS = prev;
    }
  });

  it('still injects a Bearer token when no API key is set (unchanged JWT path)', async () => {
    mockGetAuthTokens.mockResolvedValue({
      accessToken: 'jwt-token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      userId: 'user-1',
    });
    const client = new ApiClient('http://localhost:3000');
    let seen: InternalAxiosRequestConfig | undefined;
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      seen = config;
      return Promise.resolve(ok(config));
    }) as AxiosAdapter;

    await client.get('/api/sessions');

    expect(seen?.headers.Authorization).toBe('Bearer jwt-token');
    expect(seen?.headers['x-api-key']).toBeUndefined();
  });
});

describe('ApiClient.fetch (the transport handed to @bike4mind/sdk)', () => {
  const respond = (config: InternalAxiosRequestConfig, status: number, data: unknown, headers = {}) =>
    ({ data, status, statusText: '', headers, config }) as AxiosResponse;
  const httpError = (config: InternalAxiosRequestConfig, status: number, body: unknown) =>
    new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, respond(config, status, Buffer.from(JSON.stringify(body))));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends through the axios instance with the API key and returns a Response', async () => {
    const client = new ApiClient('http://localhost:3000', undefined, 'b4m_live_secret');
    let seen: InternalAxiosRequestConfig | undefined;
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      seen = config;
      return Promise.resolve(
        respond(config, 200, Buffer.from('{"id":"q1"}'), { 'content-type': 'application/json', 'x-request-id': 'r1' })
      );
    }) as AxiosAdapter;

    const response = await client.fetch('http://localhost:3000/api/v1/quests/q1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });

    expect(seen?.headers['x-api-key']).toBe('b4m_live_secret');
    expect(seen?.method).toBe('post');
    expect(seen?.data).toBe('{"a":1}');
    expect(seen?.responseType).toBe('arraybuffer');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('r1');
    expect(await response.json()).toEqual({ id: 'q1' });
  });

  it('resolves an HTTP error status as a Response for the SDK to map', async () => {
    const client = new ApiClient('http://localhost:3000', undefined, 'b4m_live_secret');
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(httpError(config, 404, { error: 'Not found' }))) as AxiosAdapter;

    const response = await client.fetch('http://localhost:3000/api/v1/quests/missing');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('refreshes an expired JWT on 401 and retries with the new token', async () => {
    const stale = {
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'user-1',
    };
    // The request and refresh interceptors read the stale token; the retry reads what the refresh stored.
    mockGetAuthTokens
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValue({ ...stale, accessToken: 'fresh', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    mockRefreshToken.mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh-2', expires_in: 900 });
    const client = new ApiClient('http://localhost:3000');
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      config.headers.Authorization === 'Bearer fresh'
        ? Promise.resolve(respond(config, 200, Buffer.from('{}')))
        : Promise.reject(make401(config))) as AxiosAdapter;

    const response = await client.fetch('http://localhost:3000/api/v1/me');

    expect(response.status).toBe(200);
    expect(mockRefreshToken).toHaveBeenCalledWith('refresh');
  });

  it('throws SessionRevokedError when the refresh token is rejected', async () => {
    mockGetAuthTokens.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'user-1',
    });
    mockRefreshToken.mockRejectedValue(refreshHttpError(400));
    const client = new ApiClient('http://localhost:3000');
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;

    expect(await rejection(client.fetch('http://localhost:3000/api/v1/me'))).toBeInstanceOf(SessionRevokedError);
  });

  it('passes a provider-key 401 through as a Response without refreshing', async () => {
    mockGetAuthTokens.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'user-1',
    });
    const client = new ApiClient('http://localhost:3000');
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(
        httpError(config, 401, { error: 'No TTS provider', errorCode: 'provider_not_configured' })
      )) as AxiosAdapter;

    const response = await client.fetch('http://localhost:3000/api/ai/tts', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(mockRefreshToken).not.toHaveBeenCalled();
  });

  it('streams an event-stream response and refuses redirects when asked', async () => {
    const client = new ApiClient('http://localhost:3000', undefined, 'b4m_live_secret');
    let seen: InternalAxiosRequestConfig | undefined;
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      seen = config;
      return Promise.resolve(respond(config, 200, Readable.from([Buffer.from('data: [DONE]\n\n')])));
    }) as AxiosAdapter;

    const response = await client.fetch('http://localhost:3000/api/ai/v1/completions', {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      redirect: 'manual',
    });

    expect(seen?.responseType).toBe('stream');
    expect(seen?.maxRedirects).toBe(0);
    expect(await response.text()).toBe('data: [DONE]\n\n');
  });

  it('rethrows a failure with no response (a timeout) as the axios error', async () => {
    const client = new ApiClient('http://localhost:3000', undefined, 'b4m_live_secret');
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(new AxiosError('timeout of 10ms exceeded', 'ECONNABORTED', config))) as AxiosAdapter;

    await expect(client.fetch('http://localhost:3000/api/v1/me')).rejects.toMatchObject({ code: 'ECONNABORTED' });
  });
});
