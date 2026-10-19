import { describe, expect, it } from 'vitest';
import { jwtExpiryMs, resolveLakeRagAuth } from './auth';
import { call, LakeRagHttpError, type LakeRagCredential } from './http';

type Call = { method: string; url: URL; headers: Record<string, string>; body?: string };

function fakeServer(
  createStatus = 201,
  createBody: unknown = { user: {}, accessToken: 'jwt-abc', refreshToken: 'r' },
  cleanupBody: unknown = { success: true, cleaned: { users: 1, dataLakes: 3 } }
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    calls.push({
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body as string | undefined,
    });
    if (String(input).includes('/api/test/create-user')) {
      return new Response(JSON.stringify(createBody), { status: createStatus });
    }
    if (String(input).includes('/api/test/cleanup')) return new Response(JSON.stringify(cleanupBody), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const base = 'https://app.example.com';

describe('resolveLakeRagAuth', () => {
  it('uses the API key as-is and never calls the E2E routes, even with a secret set', async () => {
    const { calls, fetchImpl } = fakeServer();
    const auth = await resolveLakeRagAuth({
      baseUrl: base,
      apiKey: ' b4m_live_xyz ',
      e2eCleanupSecret: 's3cret',
      fetch: fetchImpl,
    });
    await auth.cleanup();
    expect(auth).toMatchObject({ authorization: 'Bearer b4m_live_xyz', source: 'api-key' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a key that is not a b4m_live_ key', async () => {
    await expect(resolveLakeRagAuth({ baseUrl: base, apiKey: 'sk-other' })).rejects.toThrow(/b4m_live_/);
  });

  it('requires one credential', async () => {
    await expect(resolveLakeRagAuth({ baseUrl: base })).rejects.toThrow(/API key or the E2E cleanup secret/);
  });

  it('mints an e2e user the testId-scoped cleanup can find, and cleans up by that testId only', async () => {
    const { calls, fetchImpl } = fakeServer();
    const auth = await resolveLakeRagAuth({
      baseUrl: base,
      e2eCleanupSecret: 's3cret',
      testId: 'run42',
      fetch: fetchImpl,
      now: () => 1700000000000,
    });
    expect(auth.source).toBe('e2e-user');
    expect(await (auth.authorization as LakeRagCredential).header()).toBe('Bearer jwt-abc');

    const create = calls[0];
    expect(create.method).toBe('POST');
    expect(create.url.pathname).toBe('/api/test/create-user');
    expect(create.headers['x-e2e-cleanup-secret']).toBe('s3cret');
    const { email, username } = JSON.parse(create.body!) as { email: string; username: string };
    // The cleanup route's scoped pattern (e2eCleanupScope.buildE2EEmailPattern).
    expect(email).toMatch(/-run42-[0-9]+-e2e@test\.com$/);
    expect(username).toMatch(/-run42-[0-9]+-e2e$/);

    await auth.cleanup();
    await auth.cleanup();
    const cleanups = calls.filter(c => c.url.pathname === '/api/test/cleanup');
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0].method).toBe('DELETE');
    expect(cleanups[0].url.searchParams.get('testId')).toBe('run42');
    expect(cleanups[0].headers['x-e2e-cleanup-secret']).toBe('s3cret');
  });

  it('reports the lakes the cleanup deleted', async () => {
    const { fetchImpl } = fakeServer();
    const auth = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl });
    await expect(auth.cleanup()).resolves.toBe(3);
  });

  it.each([
    ['zero users', { success: true, cleaned: { users: 0 }, message: 'No e2e test users found' }],
    ['no counts', {}],
  ])('fails a cleanup that reports %s, which would strand the lakes', async (_label, cleanupBody) => {
    const { fetchImpl } = fakeServer(201, undefined, cleanupBody);
    const auth = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl });
    await expect(auth.cleanup()).rejects.toThrow(/matched no user/);
  });

  it('generates a non-empty testId when none is given', async () => {
    const { calls, fetchImpl } = fakeServer();
    const auth = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl });
    await auth.cleanup();
    const testId = calls[1].url.searchParams.get('testId');
    expect(testId).toMatch(/^[a-zA-Z0-9]+$/);
    expect(JSON.parse(calls[0].body!).email).toContain(`-${testId}-`);
  });

  it.each(['', 'run-42', 'a b'])('refuses testId %j, which would widen or miss the cleanup', async testId => {
    const { calls, fetchImpl } = fakeServer();
    await expect(
      resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', testId, fetch: fetchImpl })
    ).rejects.toThrow(/testId/);
    expect(calls).toHaveLength(0);
  });

  it('rejects cleanup when the cleanup route answers non-2xx', async () => {
    const fetchImpl = (async (input: URL | string) =>
      String(input).includes('/api/test/cleanup')
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ user: {}, accessToken: 'jwt-abc', refreshToken: 'r' }), {
            status: 201,
          })) as typeof fetch;
    const auth = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl });
    await expect(auth.cleanup()).rejects.toThrow(/-> 403/);
  });

  it('sweeps the user when create-user answers 5xx, since the route commits it before issuing a session', async () => {
    const { calls, fetchImpl } = fakeServer(500, { error: 'session issue failed' });
    await expect(resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl })).rejects.toThrow(
      /create-user -> 500/
    );
    expect(calls.map(c => c.url.pathname)).toEqual(['/api/test/create-user', '/api/test/cleanup']);
  });

  it('surfaces the create-user 5xx even when the sweep that follows also fails', async () => {
    const fetchImpl = (async (input: URL | string) =>
      String(input).includes('/api/test/create-user')
        ? new Response('{"error":"boom"}', { status: 500 })
        : new Response('{}', { status: 403 })) as typeof fetch;
    const err = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl }).catch(
      (e: unknown) => e
    );
    expect(String(err)).toMatch(/create-user -> 500/);
    expect(String(err)).not.toMatch(/cleanup/);
  });

  it('surfaces the missing-token error even when the sweep that follows also fails', async () => {
    const fetchImpl = (async (input: URL | string) =>
      String(input).includes('/api/test/create-user')
        ? new Response(JSON.stringify({ user: {}, refreshToken: 'r' }), { status: 201 })
        : new Response('{}', { status: 403 })) as typeof fetch;
    const err = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl }).catch(
      (e: unknown) => e
    );
    expect(String(err)).toMatch(/no accessToken/);
    expect(String(err)).not.toMatch(/cleanup/);
  });

  it('does not sweep on a 4xx create-user refusal', async () => {
    const { calls, fetchImpl } = fakeServer(403, { error: 'nope' });
    await expect(resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl })).rejects.toThrow(
      /create-user -> 403/
    );
    expect(calls.map(c => c.url.pathname)).toEqual(['/api/test/create-user']);
  });

  it('surfaces a create-user refusal without echoing the secret', async () => {
    const { fetchImpl } = fakeServer(403, { error: 'Test user creation is only available in development/preview' });
    const err = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl }).catch(
      (e: Error) => e
    );
    expect(String(err)).toMatch(/create-user -> 403/);
    expect(String(err)).not.toContain('s3cret');
  });

  it.each([
    ['no accessToken', { user: {}, refreshToken: 'r' }, /no accessToken/],
    ['no refreshToken', { user: {}, accessToken: 'jwt-abc' }, /no refreshToken/],
    ['an unparseable body', '<html>', /no accessToken/],
  ])('sweeps the created user when create-user returns %s', async (_label, body, message) => {
    const { calls, fetchImpl } = fakeServer(201, body);
    await expect(resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl })).rejects.toThrow(
      message
    );
    expect(calls.map(c => c.url.pathname)).toEqual(['/api/test/create-user', '/api/test/cleanup']);
  });

  it.each(['http://app.example.com', 'ftp://app.example.com'])('refuses base URL %s', async baseUrl => {
    const { calls, fetchImpl } = fakeServer();
    await expect(resolveLakeRagAuth({ baseUrl, e2eCleanupSecret: 's3cret', fetch: fetchImpl })).rejects.toThrow(
      /https/
    );
    expect(calls).toHaveLength(0);
  });
});

function jwt(expSeconds: number): string {
  const enc = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${enc({ alg: 'HS256' })}.${enc({ sub: 'u', exp: expSeconds })}.sig`;
}

describe('e2e credential renewal', () => {
  const T0 = 1_700_000_000_000;
  const first = jwt(T0 / 1000 + 30 * 60);
  const second = jwt(T0 / 1000 + 60 * 60);

  function renewingServer(opts: { refreshStatus?: number; liveTokens?: string[] } = {}) {
    const live = new Set(opts.liveTokens ?? [first, second]);
    const calls: Call[] = [];
    let refreshes = 0;
    const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = { ...(init.headers as Record<string, string>) };
      calls.push({ method: init.method ?? 'GET', url, headers, body: init.body as string | undefined });
      if (url.pathname === '/api/test/create-user')
        return new Response(JSON.stringify({ accessToken: first, refreshToken: 'refresh-1' }), { status: 201 });
      if (url.pathname === '/api/auth/refreshToken') {
        refreshes++;
        if (opts.refreshStatus) return new Response('{}', { status: opts.refreshStatus });
        return new Response(JSON.stringify({ accessToken: second, refreshToken: `refresh-${refreshes + 1}` }), {
          status: 200,
        });
      }
      const token = headers.Authorization?.replace(/^Bearer /, '');
      return token && live.has(token)
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response('{"error":"expired"}', { status: 401 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  async function resolveAt(fetchImpl: typeof fetch, clock: { t: number }) {
    const auth = await resolveLakeRagAuth({
      baseUrl: base,
      e2eCleanupSecret: 's3cret',
      fetch: fetchImpl,
      now: () => clock.t,
    });
    return { baseUrl: base, authorization: auth.authorization, fetch: fetchImpl };
  }

  it('reads the expiry from the JWT and falls back to the 30-minute TTL', () => {
    expect(jwtExpiryMs(first, 0)).toBe(T0 + 30 * 60 * 1000);
    expect(jwtExpiryMs('opaque', 5)).toBe(5 + 30 * 60 * 1000);
  });

  it('renews on a 401 with the refresh token create-user issued, then retries once', async () => {
    const { calls, fetchImpl } = renewingServer({ liveTokens: [second] });
    const api = await resolveAt(fetchImpl, { t: T0 });
    await expect(call(api, 'GET', '/api/v1/files/f1')).resolves.toEqual({ ok: true });

    const paths = calls.map(c => c.url.pathname);
    expect(paths).toEqual(['/api/test/create-user', '/api/v1/files/f1', '/api/auth/refreshToken', '/api/v1/files/f1']);
    expect(JSON.parse(calls[2].body!)).toEqual({ refreshToken: 'refresh-1' });
    expect(calls[2].headers.Authorization).toBeUndefined();
    expect(calls[3].headers.Authorization).toBe(`Bearer ${second}`);
  });

  it('renews before expiry and presents the rotated refresh token next time', async () => {
    const { calls, fetchImpl } = renewingServer();
    const clock = { t: T0 };
    const api = await resolveAt(fetchImpl, clock);
    await call(api, 'GET', '/a');
    expect(calls.filter(c => c.url.pathname === '/api/auth/refreshToken')).toHaveLength(0);

    clock.t = T0 + 26 * 60 * 1000;
    await call(api, 'GET', '/b');
    clock.t = T0 + 56 * 60 * 1000;
    await call(api, 'GET', '/c');
    const refreshes = calls.filter(c => c.url.pathname === '/api/auth/refreshToken');
    expect(refreshes.map(r => JSON.parse(r.body!).refreshToken)).toEqual(['refresh-1', 'refresh-2']);
  });

  it('surfaces the 401 when renewal is refused', async () => {
    const { fetchImpl } = renewingServer({ refreshStatus: 401, liveTokens: [] });
    const api = await resolveAt(fetchImpl, { t: T0 });
    const err = await call(api, 'GET', '/api/v1/files/f1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LakeRagHttpError);
    expect((err as LakeRagHttpError).status).toBe(401);
  });
});
