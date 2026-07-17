import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

vi.mock('../utils/Logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const mockGetAuthTokens = vi.fn();
vi.mock('../storage/ConfigStore', () => ({
  ConfigStore: class {
    getAuthTokens = mockGetAuthTokens;
    setAuthTokens = vi.fn();
    clearAuthTokens = vi.fn();
    isAuthenticated = vi.fn();
  },
}));

const mockRefreshToken = vi.fn();
vi.mock('./OAuthClient', () => ({
  OAuthClient: class {
    refreshToken = mockRefreshToken;
  },
}));

import { ApiClient } from './ApiClient';

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
