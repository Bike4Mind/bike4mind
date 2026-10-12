import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

vi.mock('../utils/Logger', () => ({
  logger: new Proxy({}, { get: () => vi.fn() }),
}));

const mockGetAuthTokens = vi.fn();
const mockSetAuthTokens = vi.fn();
vi.mock('../storage/ConfigStore', () => ({
  ConfigStore: class {
    getAuthTokens = mockGetAuthTokens;
    setAuthTokens = mockSetAuthTokens;
    clearAuthTokens = vi.fn();
    isAuthenticated = vi.fn();
  },
}));

const mockRefreshToken = vi.fn();
vi.mock('../auth/OAuthClient', () => ({
  OAuthClient: class {
    refreshToken = mockRefreshToken;
  },
}));

import { ApiClient } from '../auth/ApiClient';
import { ServerLlmBackend } from './ServerLlmBackend';

describe('ServerLlmBackend 401 token refresh', () => {
  it('refreshes, retries the completion with the new token and streams the 200', async () => {
    mockGetAuthTokens.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'user-1',
    });
    // The retry re-runs the request interceptor, which reads the stored token back.
    mockSetAuthTokens.mockImplementation(async (tokens: unknown) => mockGetAuthTokens.mockResolvedValue(tokens));
    mockRefreshToken.mockResolvedValue({ access_token: 'fresh', refresh_token: 'refresh2', expires_in: 3600 });

    const seenAuth: unknown[] = [];
    const apiClient = new ApiClient('http://localhost:3000');
    apiClient.getAxiosInstance().defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      const auth = config.headers.Authorization;
      seenAuth.push(auth);
      if (auth !== 'Bearer fresh') {
        throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
          status: 401,
          statusText: 'Unauthorized',
          data: {},
          headers: {},
          config,
        } as AxiosResponse);
      }
      const stream = new PassThrough();
      stream.write(`data: ${JSON.stringify({ type: 'content', text: 'Hello' })}\n\n`);
      stream.write('data: [DONE]\n\n');
      stream.end();
      return { data: stream, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
    }) as AxiosAdapter;

    const backend = new ServerLlmBackend({ apiClient, model: 'test-model', sseCompletionsUrl: '/completions' });
    const events = [];
    for await (const event of backend.open({ model: 'test-model', messages: [], options: {} })) events.push(event);

    expect(events).toEqual([{ type: 'content', text: 'Hello' }]);
    expect(mockRefreshToken).toHaveBeenCalledTimes(1);
    expect(seenAuth).toEqual(['Bearer stale', 'Bearer fresh']);
  });
});
