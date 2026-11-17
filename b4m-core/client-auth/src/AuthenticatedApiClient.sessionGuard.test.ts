import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedApiClient } from './AuthenticatedApiClient';
import type { AuthTokens, TokenStore } from './tokens';

function tokens(userId: string): AuthTokens {
  return {
    userId,
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: '2035-01-01T00:00:00Z',
  };
}
function storeFor(initial: AuthTokens) {
  let current: AuthTokens | null = initial;
  const store: TokenStore = {
    getAuthTokens: async () => current,
    reloadAuthTokens: async () => current,
    setAuthTokens: async (next, expected) => {
      if (expected !== undefined && current?.refreshToken !== expected) return false;
      current = next;
      return true;
    },
    clearAuthTokens: async expected => {
      if (expected !== undefined && current?.refreshToken !== expected) return false;
      current = null;
      return true;
    },
    isAuthenticated: async () => current !== null,
  };
  return { store, current: () => current };
}
function response(config: InternalAxiosRequestConfig): AxiosResponse<unknown> {
  return { data: { jobId: 'remote-job' }, status: 202, statusText: 'Accepted', config, headers: {} };
}
function refused(config: InternalAxiosRequestConfig, status: number) {
  return new AxiosError('Request refused', 'ERR_BAD_RESPONSE', config, undefined, { ...response(config), status });
}
function clientFor(store: TokenStore, isSessionCurrent?: (value: AuthTokens | null) => boolean) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const refreshToken = vi.fn(async () => ({
    access_token: 'refreshed-a',
    refresh_token: 'rotated-a',
    expires_in: 1800,
    token_type: 'Bearer',
  }));
  const options = {
    baseUrl: 'https://api.example.test',
    tokenStore: store,
    oauthClient: { refreshToken },
    logger,
    reauthMessages: { refreshFailed: 'Session expired.', stillUnauthorized: 'Session refused.' },
    refreshUnexpiredOn401: true,
    isSessionCurrent,
  };
  return { client: new AuthenticatedApiClient(options), logger, refreshToken, options };
}

describe('account-scoped HTTP requests', () => {
  it('checks the account after an awaited initial credential read', async () => {
    const { store } = storeFor(tokens('a'));
    const read = Promise.withResolvers<AuthTokens | null>();
    store.getAuthTokens = () => read.promise;
    const { client } = clientFor(store, value => !value || value.userId === 'a');
    const sent = vi.fn<AxiosAdapter>(async config => response(config));
    client.getAxiosInstance().defaults.adapter = sent;
    const outcome = client.post('/api/paid', { prompt: 'private-a-context' }).then(
      () => 'sent',
      () => 'refused'
    );
    read.resolve(tokens('b'));
    expect(await outcome).toBe('refused');
    expect(sent).not.toHaveBeenCalled();
  });

  it('keeps a pending request attached to its initiating account on a 401', async () => {
    const { store, current } = storeFor(tokens('a'));
    const { client, refreshToken } = clientFor(store, value => !value || value.userId === 'a');
    const entered = Promise.withResolvers<InternalAxiosRequestConfig>();
    const ack = Promise.withResolvers<AxiosResponse<unknown>>();
    const sent: InternalAxiosRequestConfig[] = [];
    client.getAxiosInstance().defaults.adapter = async config => {
      sent.push(config);
      if (sent.length === 1) {
        entered.resolve(config);
        return ack.promise;
      }
      return response(config);
    };
    const outcome = client.post('/api/paid', { prompt: 'private-a-context' }).then(
      () => 'sent',
      () => 'refused'
    );
    const first = await entered.promise;
    expect(first.headers.Authorization).toBe('Bearer access-a');
    await store.setAuthTokens(tokens('b'));
    ack.reject(refused(first, 401));
    expect(await outcome).toBe('refused');
    expect(sent).toHaveLength(1);
    expect(refreshToken).not.toHaveBeenCalled();
    expect(current()?.userId).toBe('b');
  });

  it('refreshes and retries for the same account', async () => {
    const { store } = storeFor(tokens('a'));
    const { client, refreshToken } = clientFor(store, value => !value || value.userId === 'a');
    const sent: string[] = [];
    client.getAxiosInstance().defaults.adapter = async config => {
      sent.push(String(config.headers.Authorization));
      if (sent.length === 1) throw refused(config, 401);
      return response(config);
    };
    expect(await client.post('/api/paid', { prompt: 'same-account' })).toEqual({ jobId: 'remote-job' });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['Bearer access-a', 'Bearer refreshed-a']);
  });

  it('shares the proactive refresh rotation with a session-bound fork', async () => {
    const { store } = storeFor(tokens('a'));
    const { client: base, refreshToken } = clientFor(store);
    const entered = Promise.withResolvers<void>();
    const grant = Promise.withResolvers<Awaited<ReturnType<typeof refreshToken>>>();
    refreshToken.mockImplementation(() => {
      entered.resolve();
      return grant.promise;
    });
    const bound = base.withSessionGuard(value => !value || value.userId === 'a');
    const proactive = base.refreshSession();
    await entered.promise;
    const joined = bound.refreshSession();
    grant.resolve({ access_token: 'new-a', refresh_token: 'rotated-a', expires_in: 1800, token_type: 'Bearer' });
    expect(await proactive).toEqual(await joined);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not notify session cleanup after a newer sign-in completes', async () => {
    const { store, current } = storeFor(tokens('a'));
    const { options, refreshToken } = clientFor(store);
    const cleared = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const clear = store.clearAuthTokens;
    store.clearAuthTokens = async expected => {
      const result = await clear(expected);
      cleared.resolve();
      await finish.promise;
      return result;
    };
    refreshToken.mockRejectedValue(
      new AxiosError('rejected', undefined, undefined, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        data: {},
        config: {} as InternalAxiosRequestConfig,
      })
    );
    const onTokensCleared = vi.fn();
    const base = new AuthenticatedApiClient({ ...options, onTokensCleared });
    const refreshing = base.refreshSession();
    await cleared.promise;
    await store.setAuthTokens(tokens('b'));
    finish.resolve();
    expect(await refreshing).toEqual(tokens('b'));
    expect(current()?.userId).toBe('b');
    expect(onTokensCleared).not.toHaveBeenCalled();
  });

  it('checks the captured session again at the transport boundary', async () => {
    const { store } = storeFor(tokens('a'));
    let active = true;
    let checks = 0;
    const { client } = clientFor(store, () => {
      checks++;
      if (checks === 1)
        queueMicrotask(() => {
          active = false;
        });
      return active;
    });
    const sent = vi.fn<AxiosAdapter>(async config => response(config));
    client.getAxiosInstance().defaults.adapter = sent;
    await expect(client.post('/api/paid', {})).rejects.toMatchObject({
      name: 'SessionChangedError',
      beforeRequest: true,
    });
    expect(sent).not.toHaveBeenCalled();
  });

  it.each([false, true, undefined])(
    'never replays rejected credentials after an inconclusive clear (%s)',
    async cleared => {
      const { store, current } = storeFor(tokens('a'));
      store.clearAuthTokens = vi.fn(async () => cleared);
      const { options, refreshToken } = clientFor(store);
      const onTokensCleared = vi.fn();
      const client = new AuthenticatedApiClient({ ...options, onTokensCleared });
      const dispatch = vi.fn<AxiosAdapter>(async config => {
        throw refused(config, 401);
      });
      client.getAxiosInstance().defaults.adapter = dispatch;
      refreshToken.mockRejectedValue(
        new AxiosError('Refresh rejected', undefined, undefined, undefined, {
          status: 400,
          statusText: 'Rejected',
          headers: {},
          data: {},
          config: {} as InternalAxiosRequestConfig,
        })
      );
      await expect(client.post('/api/paid', {})).rejects.toMatchObject({
        name: 'SessionRevokedError',
        message: options.reauthMessages.refreshFailed,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(current()).toEqual(tokens('a'));
      expect(onTokensCleared).not.toHaveBeenCalled();
    }
  );

  it('checks captured ownership immediately before a cleanup callback', async () => {
    const { store } = storeFor(tokens('a'));
    let active = true;
    const { options, refreshToken } = clientFor(store, value => {
      if (!value)
        queueMicrotask(() => {
          active = false;
        });
      return active;
    });
    const onTokensCleared = vi.fn();
    const client = new AuthenticatedApiClient({ ...options, onTokensCleared });
    refreshToken.mockRejectedValue(
      new AxiosError('Refresh rejected', undefined, undefined, undefined, {
        status: 400,
        statusText: 'Rejected',
        headers: {},
        data: {},
        config: {} as InternalAxiosRequestConfig,
      })
    );
    await expect(client.refreshSession()).rejects.toMatchObject({ name: 'SessionChangedError' });
    expect(onTokensCleared).not.toHaveBeenCalled();
  });

  it('records bounded diagnostics without request content or credentials', async () => {
    const { store } = storeFor(tokens('a'));
    const { client, logger } = clientFor(store, value => !value || value.userId === 'a');
    client.getAxiosInstance().defaults.adapter = async config => {
      throw refused(config, 403);
    };
    await expect(client.post('/api/paid?note=private-query', { prompt: 'private-a-context' })).rejects.toThrow();
    const logged = JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain('private-a-context');
    expect(logged).not.toContain('private-query');
    expect(logged).not.toContain('access-a');
    expect(logged).not.toContain('refresh-a');
  });
});
