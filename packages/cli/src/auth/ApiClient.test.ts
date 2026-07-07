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

  it('returns false when refresh itself fails - a genuine revocation', async () => {
    client.getAxiosInstance().defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(make401(config))) as AxiosAdapter;
    mockRefreshToken.mockRejectedValue(new Error('invalid_grant'));

    expect(await client.checkSessionValid()).toBe(false);
  });

  it('returns true on a non-auth error (network blip) - treated as transient, not revoked', async () => {
    client.getAxiosInstance().defaults.adapter = (() => Promise.reject(new Error('Network Error'))) as AxiosAdapter;

    expect(await client.checkSessionValid()).toBe(true);
  });
});
