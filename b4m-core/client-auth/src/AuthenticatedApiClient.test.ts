import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  AuthenticatedApiClient,
  SessionRevokedError,
  type AuthenticatedApiClientOptions,
} from './AuthenticatedApiClient';
import type { RefreshTokenResponse } from './DeviceFlowClient';
import type { AuthTokens, TokenStore } from './tokens';

const silentLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

const MESSAGES = { refreshFailed: 'Session expired.', stillUnauthorized: 'Session invalid.' };

function tokens(overrides: Partial<AuthTokens> = {}): AuthTokens {
  return {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    userId: 'user-1',
    ...overrides,
  };
}

/** A store whose durable copy can be rewritten behind its cache, as another process would. */
function memoryStore(initial: AuthTokens | null) {
  let durable = initial;
  let cached = initial;
  const store = {
    getAuthTokens: vi.fn(async () => cached),
    reloadAuthTokens: vi.fn(async () => {
      cached = durable;
      return durable;
    }),
    setAuthTokens: vi.fn(async (next: AuthTokens) => {
      durable = next;
      cached = next;
    }),
    clearAuthTokens: vi.fn(async () => {
      durable = null;
      cached = null;
    }),
    isAuthenticated: vi.fn(async () => cached !== null),
  } satisfies TokenStore;
  return {
    store,
    durable: () => durable,
    /** Another process writing the shared storage; this process's cache does not see it. */
    writeBehind(next: AuthTokens | null) {
      durable = next;
    },
  };
}

function httpError(status: number, config: InternalAxiosRequestConfig = {} as InternalAxiosRequestConfig) {
  return new AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, {}, {
    status,
    statusText: String(status),
    data: {},
    headers: {},
    config,
  } as AxiosResponse);
}

function grant(index: number, rotate = true): RefreshTokenResponse {
  return {
    access_token: `access-${index}`,
    refresh_token: rotate ? `refresh-${index}` : undefined,
    token_type: 'Bearer',
    expires_in: 1800,
  } as RefreshTokenResponse;
}

function build(
  store: TokenStore,
  refreshToken: ReturnType<typeof vi.fn>,
  onTokensCleared = vi.fn(),
  options: Partial<AuthenticatedApiClientOptions> = {}
) {
  const client = new AuthenticatedApiClient({
    baseUrl: 'https://b4m.example.com',
    tokenStore: store,
    oauthClient: { refreshToken },
    logger: silentLogger,
    reauthMessages: MESSAGES,
    onTokensCleared,
    ...options,
  });
  // The API accepts only `access-1`; anything else is a 401.
  client.getAxiosInstance().defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    if (config.headers.Authorization === 'Bearer access-1') {
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
    }
    throw httpError(401, config);
  }) as AxiosAdapter;
  return { client, onTokensCleared };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('Expected a rejection');
}

describe('AuthenticatedApiClient refresh failures', () => {
  it.each([
    ['a 503', httpError(503)],
    ['a 429', httpError(429)],
    ['a timeout', new AxiosError('timeout of 30000ms exceeded', 'ECONNABORTED')],
    ['a network error', new AxiosError('Network Error', 'ERR_NETWORK')],
  ])('keeps the stored tokens when the refresh fails with %s', async (_label, failure) => {
    const stored = tokens();
    const { store, durable } = memoryStore(stored);
    const { client, onTokensCleared } = build(store, vi.fn().mockRejectedValue(failure));

    const err = await rejection(client.get('/api/identify'));

    expect(err).not.toBeInstanceOf(SessionRevokedError);
    expect(err.message).toBe(MESSAGES.refreshFailed);
    expect(store.clearAuthTokens).not.toHaveBeenCalled();
    expect(onTokensCleared).not.toHaveBeenCalled();
    expect(durable()).toEqual(stored);
  });

  it.each([400, 401])('clears the tokens and reports why when the refresh endpoint answers %i', async status => {
    const { store, durable } = memoryStore(tokens());
    const { client, onTokensCleared } = build(store, vi.fn().mockRejectedValue(httpError(status)));

    const err = await rejection(client.get('/api/identify'));

    expect(err).toBeInstanceOf(SessionRevokedError);
    expect(durable()).toBeNull();
    expect(onTokensCleared).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`));
  });

  it('does not clear a token that another process rotated in while the rejected exchange was in flight', async () => {
    const memory = memoryStore(tokens());
    const newer = tokens({ accessToken: 'access-9', refreshToken: 'refresh-9' });
    const refreshToken = vi.fn(async () => {
      memory.writeBehind(newer);
      throw httpError(401);
    });
    const { client, onTokensCleared } = build(memory.store, refreshToken);

    await expect(client.refreshSession()).resolves.toEqual(newer);
    expect(memory.durable()).toEqual(newer);
    expect(onTokensCleared).not.toHaveBeenCalled();
  });

  it('keeps the tokens when a request still 401s after a successful refresh', async () => {
    const { store, durable } = memoryStore(tokens());
    const { client, onTokensCleared } = build(store, vi.fn().mockResolvedValue(grant(2)));

    const err = await rejection(client.get('/api/identify'));

    expect(err).toBeInstanceOf(SessionRevokedError);
    expect(err.message).toBe(MESSAGES.stillUnauthorized);
    expect(durable()?.refreshToken).toBe('refresh-2');
    expect(onTokensCleared).not.toHaveBeenCalled();
  });
});

describe('AuthenticatedApiClient single-flight refresh', () => {
  it('makes one refresh exchange for a burst of concurrent 401s', async () => {
    const { store } = memoryStore(tokens());
    let release: (value: RefreshTokenResponse) => void = () => {};
    const refreshToken = vi.fn(() => new Promise<RefreshTokenResponse>(resolve => (release = resolve)));
    const { client } = build(store, refreshToken);

    const calls = [client.get('/a'), client.get('/b'), client.get('/c')];
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalled());
    release(grant(1));

    await expect(Promise.all(calls)).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('shares one exchange between a host-driven refresh and a 401', async () => {
    const { store } = memoryStore(tokens());
    let release: (value: RefreshTokenResponse) => void = () => {};
    const refreshToken = vi.fn(() => new Promise<RefreshTokenResponse>(resolve => (release = resolve)));
    const { client } = build(store, refreshToken);

    const proactive = client.refreshSession('access-0');
    const request = client.get('/a');
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalled());
    release(grant(1));

    await expect(proactive).resolves.toMatchObject({ accessToken: 'access-1' });
    await expect(request).resolves.toEqual({ ok: true });
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('exchanges again on a later refresh once the previous one has settled', async () => {
    const { store } = memoryStore(tokens());
    const refreshToken = vi.fn().mockResolvedValueOnce(grant(1)).mockResolvedValueOnce(grant(2));
    const { client } = build(store, refreshToken);

    await expect(client.refreshSession()).resolves.toMatchObject({ accessToken: 'access-1' });
    await expect(client.refreshSession()).resolves.toMatchObject({ accessToken: 'access-2' });
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it('retries a 401 that lands just after a refresh with the stored token, without another exchange', async () => {
    const { store } = memoryStore(
      tokens({ accessToken: 'access-1', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    );
    // The request goes out with the token the store held when it was built; by the time the 401
    // comes back the store holds access-1, as it would after a concurrent refresh replaced it.
    store.getAuthTokens.mockResolvedValueOnce(tokens({ accessToken: 'access-0' }));
    const refreshToken = vi.fn();
    const { client } = build(store, refreshToken);
    const seen: Array<string | undefined> = [];
    const adapter = client.getAxiosInstance().defaults.adapter as AxiosAdapter;
    client.getAxiosInstance().defaults.adapter = (async config => {
      seen.push(config.headers.Authorization as string | undefined);
      return adapter(config);
    }) as AxiosAdapter;

    await expect(client.get('/a')).resolves.toEqual({ ok: true });
    expect(seen).toEqual(['Bearer access-0', 'Bearer access-1']);
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

describe('AuthenticatedApiClient refresh write-back', () => {
  it('never writes back the refresh token it presented when a newer one was stored meanwhile', async () => {
    const memory = memoryStore(tokens());
    const newer = tokens({ accessToken: 'access-7', refreshToken: 'refresh-7' });
    // The server coalesced this exchange onto a sibling's rotation, so it carries no new
    // refresh token - the case that used to fall back to the stale presented one.
    const refreshToken = vi.fn(async () => {
      memory.writeBehind(newer);
      return grant(1, false);
    });
    const { client } = build(memory.store, refreshToken);

    await expect(client.refreshSession()).resolves.toEqual(newer);
    expect(memory.store.setAuthTokens).not.toHaveBeenCalled();
    expect(memory.durable()).toEqual(newer);
  });

  it('does not resurrect tokens that were cleared during the exchange', async () => {
    const memory = memoryStore(tokens());
    const refreshToken = vi.fn(async () => {
      memory.writeBehind(null);
      return grant(1);
    });
    const { client } = build(memory.store, refreshToken);

    await expect(client.refreshSession()).rejects.toThrow();
    expect(memory.durable()).toBeNull();
  });

  it('keeps the presented refresh token when the server does not rotate it', async () => {
    const memory = memoryStore(tokens());
    const { client } = build(memory.store, vi.fn().mockResolvedValue(grant(1, false)));

    await client.refreshSession();

    expect(memory.durable()).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-0' });
  });
});

describe('AuthenticatedApiClient cross-process refresh', () => {
  it('presents the refresh token in storage, not the cached one another process already rotated', async () => {
    const memory = memoryStore(tokens());
    memory.writeBehind(tokens({ accessToken: 'access-5', refreshToken: 'refresh-5' }));
    const refreshToken = vi.fn().mockResolvedValue(grant(6));
    const { client } = build(memory.store, refreshToken);

    await client.refreshSession();

    expect(refreshToken).toHaveBeenCalledWith('refresh-5');
    expect(memory.durable()).toMatchObject({ refreshToken: 'refresh-6' });
  });

  it('adopts a still-valid token another process refreshed instead of exchanging again', async () => {
    const memory = memoryStore(tokens());
    const sibling = tokens({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    memory.writeBehind(sibling);
    const refreshToken = vi.fn();
    const { client } = build(memory.store, refreshToken);

    await expect(client.get('/a')).resolves.toEqual({ ok: true });
    expect(refreshToken).not.toHaveBeenCalled();
    expect(memory.store.reloadAuthTokens).toHaveBeenCalled();
  });
});

describe('AuthenticatedApiClient refreshUnexpiredOn401', () => {
  const unexpired = (overrides: Partial<AuthTokens> = {}) =>
    tokens({ expiresAt: new Date(Date.now() + 600_000).toISOString(), ...overrides });

  it('leaves a 401 on an unexpired token alone by default', async () => {
    const { store } = memoryStore(unexpired());
    const refreshToken = vi.fn().mockResolvedValue(grant(1));
    const { client } = build(store, refreshToken);

    const err = await rejection(client.get('/a'));

    expect(err).toBeInstanceOf(AxiosError);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('refreshes and retries once when the server refuses a token still inside its lifetime', async () => {
    const { store, durable } = memoryStore(unexpired());
    const refreshToken = vi.fn().mockResolvedValue(grant(1));
    const { client } = build(store, refreshToken, vi.fn(), { refreshUnexpiredOn401: true });

    await expect(client.get('/a')).resolves.toEqual({ ok: true });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(durable()?.accessToken).toBe('access-1');
  });

  it('shares one refresh between concurrent 401s on an unexpired token', async () => {
    const { store } = memoryStore(unexpired());
    let release: (value: RefreshTokenResponse) => void = () => {};
    const refreshToken = vi.fn(() => new Promise<RefreshTokenResponse>(resolve => (release = resolve)));
    const { client } = build(store, refreshToken, vi.fn(), { refreshUnexpiredOn401: true });

    const calls = [client.get('/a'), client.get('/b'), client.get('/c')];
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalled());
    release(grant(1));

    await expect(Promise.all(calls)).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('adopts a token another process rotated into storage instead of exchanging', async () => {
    const memory = memoryStore(unexpired());
    memory.writeBehind(unexpired({ accessToken: 'access-1', refreshToken: 'refresh-1' }));
    const refreshToken = vi.fn();
    const { client } = build(memory.store, refreshToken, vi.fn(), { refreshUnexpiredOn401: true });

    await expect(client.get('/a')).resolves.toEqual({ ok: true });
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('reports a request that is still refused after the refresh', async () => {
    const { store, durable } = memoryStore(unexpired());
    const onStillUnauthorized = vi.fn();
    const { client, onTokensCleared } = build(store, vi.fn().mockResolvedValue(grant(2)), vi.fn(), {
      refreshUnexpiredOn401: true,
      onStillUnauthorized,
    });

    const err = await rejection(client.get('/a'));

    expect(err).toBeInstanceOf(SessionRevokedError);
    expect(onStillUnauthorized).toHaveBeenCalledTimes(1);
    expect(onTokensCleared).not.toHaveBeenCalled();
    expect(durable()?.refreshToken).toBe('refresh-2');
  });
});

describe('AuthenticatedApiClient streamed 401 bodies', () => {
  it('buffers a streamed 401 body so isPassThrough401 and the caller can both read it', async () => {
    const { store } = memoryStore(tokens());
    const refreshToken = vi.fn();
    const isPassThrough401 = vi.fn((data: unknown) => typeof data === 'string' && data.includes('provider_rejected'));
    const { client } = build(store, refreshToken, vi.fn(), { isPassThrough401 });
    client.getAxiosInstance().defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError('HTTP 401', 'ERR_BAD_REQUEST', config, {}, {
        status: 401,
        statusText: '401',
        data: Readable.from([Buffer.from('{"errorCode":"provider_rejected"}')]),
        headers: {},
        config,
      } as AxiosResponse);
    }) as AxiosAdapter;

    const err = (await rejection(client.get('/a', { responseType: 'stream' }))) as AxiosError;

    expect(refreshToken).not.toHaveBeenCalled();
    expect(err.response?.data).toBe('{"errorCode":"provider_rejected"}');
  });
});
