import { describe, expect, it } from 'vitest';
import { resolveLakeRagAuth } from './auth';

type Call = { method: string; url: URL; headers: Record<string, string>; body?: string };

function fakeServer(createStatus = 201, createBody: unknown = { user: {}, accessToken: 'jwt-abc', refreshToken: 'r' }) {
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
    expect(auth).toMatchObject({ authorization: 'Bearer jwt-abc', source: 'e2e-user' });

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

  it('surfaces a create-user refusal without echoing the secret', async () => {
    const { fetchImpl } = fakeServer(403, { error: 'Test user creation is only available in development/preview' });
    const err = await resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl }).catch(
      (e: Error) => e
    );
    expect(String(err)).toMatch(/create-user -> 403/);
    expect(String(err)).not.toContain('s3cret');
  });

  it('throws when create-user returns no accessToken', async () => {
    const { fetchImpl } = fakeServer(201, { user: {} });
    await expect(resolveLakeRagAuth({ baseUrl: base, e2eCleanupSecret: 's3cret', fetch: fetchImpl })).rejects.toThrow(
      /no accessToken/
    );
  });
});
