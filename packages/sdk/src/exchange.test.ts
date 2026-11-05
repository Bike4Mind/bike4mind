import { afterEach, describe, expect, it, vi } from 'vitest';
import { B4mApiError, exchangeIdToken } from './index';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

const base = {
  baseUrl: 'https://b4m.example.com/',
  clientId: 'cid',
  clientSecret: 'csecret',
  idToken: 'idtok',
};

afterEach(() => vi.useRealTimers());

describe('exchangeIdToken', () => {
  it('posts snake_case JSON to /api/oauth/ai-token and returns the key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json({ api_key: 'b4m_live_x', token_type: 'ApiKey', expires_in: 600, scope: 'ai:generate me:read' })
      );
    const signal = new AbortController().signal;

    const result = await exchangeIdToken({ ...base, scope: 'ai:generate me:read', signal, fetch: fetchMock });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://b4m.example.com/api/oauth/ai-token');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(JSON.parse(init?.body as string)).toEqual({
      client_id: 'cid',
      client_secret: 'csecret',
      id_token: 'idtok',
      scope: 'ai:generate me:read',
    });
    expect(init?.signal).toBe(signal);
    expect(result).toEqual({
      apiKey: 'b4m_live_x',
      scope: 'ai:generate me:read',
      expiresAt: new Date('2026-01-01T00:10:00Z'),
    });
  });

  it('omits scope when not given and defaults expiresAt to 900 s and scope to ai:generate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ api_key: 'k' }));

    const result = await exchangeIdToken({ ...base, fetch: fetchMock });

    expect('scope' in JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toBe(false);
    expect(result.expiresAt).toEqual(new Date('2026-01-01T00:15:00Z'));
    expect(result.scope).toBe('ai:generate');
  });

  it('throws a plain Error when a 2xx body has no api_key', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}));
    const error = await exchangeIdToken({ ...base, fetch: fetchMock }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(B4mApiError);
  });

  it('rejects a bad baseUrl naming exchangeIdToken', async () => {
    await expect(exchangeIdToken({ ...base, baseUrl: 'not a url' })).rejects.toThrow(/exchangeIdToken: baseUrl/);
  });

  it.each<[number, string, Record<string, string>?]>([
    [400, 'invalid_request'],
    [401, 'invalid_client'],
    [401, 'invalid_grant'],
    [403, 'access_denied'],
    [403, 'invalid_scope'],
    [403, 'subscription_required'],
    [503, 'temporarily_unavailable'],
    [429, 'temporarily_unavailable', { 'retry-after': '30' }],
  ])('throws B4mApiError for %i %s', async (status, code, headers) => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ error: code, error_description: `desc ${code}` }, { status, headers }));

    const error: unknown = await exchangeIdToken({ ...base, fetch: fetchMock }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(B4mApiError);
    expect(error).toMatchObject({ status, errorCode: code, message: `desc ${code}` });
    if (headers) expect(error).toMatchObject({ retryAfterSeconds: 30 });
  });
});
