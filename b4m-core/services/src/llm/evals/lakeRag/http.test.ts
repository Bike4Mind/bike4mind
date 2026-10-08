import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyExcerpt, call, lakeRagUrl, MAX_429_RETRIES, type LakeRagCredential } from './http';

describe('lakeRagUrl', () => {
  it.each(['https://app.example.com', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'accepts %s',
    base => {
      expect(lakeRagUrl(base, '/api/x').pathname).toBe('/api/x');
    }
  );

  it.each(['http://app.example.com', 'http://localhost.example.com'])('refuses plain http to %s', base => {
    expect(() => lakeRagUrl(base, '/api/x')).toThrow(/https/);
  });
});

describe('bodyExcerpt', () => {
  it('redacts a token cut short by the scan cap or missing its signature', () => {
    expect(bodyExcerpt('token eyJhbGciOi.eyJzdWIi')).toBe('token [jwt redacted]');
    expect(bodyExcerpt(`${' '.repeat(8180)}eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig`)).toBe('[jwt redacted]');
  });

  it('bounds the work on a huge body of unterminated token prefixes', () => {
    const started = Date.now();
    bodyExcerpt('eyJ'.repeat(200_000) + '!');
    bodyExcerpt('eyJa.'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('redacts token-shaped runs and flattens control characters', () => {
    const out = bodyExcerpt('bad key b4m_live_abc123 and eyJhbGciOi.eyJzdWIiOiJ1In0.c2ln\n\tline\u0007two');
    expect(out).toBe('bad key b4m_live_[redacted] and [jwt redacted] line two');
  });

  it('caps the excerpt', () => {
    const out = bodyExcerpt('x'.repeat(1000));
    expect(out).toBe(`${'x'.repeat(200)}...`);
  });
});

describe('call 429 backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tooMany = (body = '{}', headers: Record<string, string> = {}) => new Response(body, { status: 429, headers });
  const ok = () => new Response('{"ok":true}', { status: 200 });

  /** Serves `responses` in order (the last repeats) and records the time and auth of each send. */
  function server(responses: Response[], authorization: string | LakeRagCredential = 'Bearer k') {
    const sends: { at: number; auth: string }[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init: RequestInit = {}) => {
      sends.push({ at: Date.now(), auth: (init.headers as Record<string, string>).Authorization });
      return responses[Math.min(sends.length - 1, responses.length - 1)].clone();
    }) as unknown as typeof fetch;
    return { api: { baseUrl: 'https://app.example.com', authorization, fetch: fetchImpl }, sends };
  }

  it('waits the Retry-After seconds before retrying', async () => {
    const { api, sends } = server([tooMany('{}', { 'Retry-After': '7' }), ok()]);
    const pending = call(api, 'POST', '/api/x');
    await vi.advanceTimersByTimeAsync(6_999);
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(sends[1].at - sends[0].at).toBe(7_000);
  });

  it('backs off 5s then 10s when a 429 carries neither a header nor a body hint', async () => {
    const { api, sends } = server([tooMany('{}'), tooMany('{}'), ok()]);
    const pending = call(api, 'POST', '/api/x');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(sends.slice(1).map((s, i) => s.at - sends[i].at)).toEqual([5_000, 10_000]);
  });

  it('falls back to the "retry in Ns" body hint', async () => {
    const { api, sends } = server([tooMany('{"error":"Rate limited, retry in 37s"}'), ok()]);
    const pending = call(api, 'POST', '/api/x');
    await vi.advanceTimersByTimeAsync(37_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(sends[1].at - sends[0].at).toBe(37_000);
  });

  it('reads the "Try again in N seconds" wording too', async () => {
    const { api, sends } = server([tooMany('{"error":"Rate limit exceeded. Try again in 3 seconds."}'), ok()]);
    const pending = call(api, 'GET', '/api/x');
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(sends[1].at - sends[0].at).toBe(3_000);
  });

  it('gives up after the retry cap and throws the 429', async () => {
    const { api, sends } = server([tooMany('{}', { 'Retry-After': '1' })]);
    const pending = call(api, 'GET', '/api/x');
    const settled = expect(pending).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(sends).toHaveLength(1 + MAX_429_RETRIES);
  });

  it('throws at once when the asked-for wait overruns the total budget', async () => {
    const { api, sends } = server([tooMany('{}', { 'Retry-After': '600' }), ok()]);
    await expect(call(api, 'GET', '/api/x')).rejects.toMatchObject({ status: 429 });
    expect(sends).toHaveLength(1);
  });

  it('caps the total wait across retries', async () => {
    const { api, sends } = server([tooMany('{}', { 'Retry-After': '70' })]);
    const pending = call(api, 'GET', '/api/x');
    const settled = expect(pending).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(300_000);
    await settled;
    // 70s + 70s fits the 180s budget, a third 70s does not.
    expect(sends).toHaveLength(3);
  });

  it.each(['-5', 'abc 2', 'soon'])('ignores a malformed Retry-After %s and uses the body hint', async header => {
    const { api, sends } = server([tooMany('{"error":"retry in 4s"}', { 'Retry-After': header }), ok()]);
    const pending = call(api, 'GET', '/api/x');
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;
    expect(sends[1].at - sends[0].at).toBe(4_000);
  });

  it('reads an HTTP-date Retry-After relative to now', async () => {
    const at = new Date(Date.now() + 9_000).toUTCString();
    const { api, sends } = server([tooMany('{}', { 'Retry-After': at }), ok()]);
    const pending = call(api, 'GET', '/api/x');
    await vi.advanceTimersByTimeAsync(9_000);
    await pending;
    expect(sends[1].at - sends[0].at).toBeLessThanOrEqual(9_000);
    expect(sends[1].at - sends[0].at).toBeGreaterThan(8_000);
  });

  it('still renews a 401 that follows a 429 backoff', async () => {
    let token = 'Bearer old';
    const credential: LakeRagCredential = {
      header: async () => token,
      renew: vi.fn(async () => {
        token = 'Bearer new';
        return true;
      }),
    };
    const { api, sends } = server(
      [tooMany('{}', { 'Retry-After': '1' }), new Response('', { status: 401 }), ok()],
      credential
    );
    const pending = call(api, 'GET', '/api/x');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(sends.map(s => s.auth)).toEqual(['Bearer old', 'Bearer old', 'Bearer new']);
  });

  it.each([500, 503, 400])('does not retry a %i', async status => {
    const { api, sends } = server([new Response('{}', { status, headers: { 'Retry-After': '1' } }), ok()]);
    await expect(call(api, 'GET', '/api/x')).rejects.toMatchObject({ status });
    expect(sends).toHaveLength(1);
  });

  it('composes with the 401 renewal: renews once, backs off a 429, re-reads the header', async () => {
    let token = 'Bearer old';
    const credential: LakeRagCredential = {
      header: async () => token,
      renew: vi.fn(async () => {
        token = 'Bearer new';
        return true;
      }),
    };
    const { api, sends } = server(
      [new Response('', { status: 401 }), tooMany('{}', { 'Retry-After': '2' }), new Response('', { status: 401 })],
      credential
    );
    const pending = call(api, 'GET', '/api/x');
    const settled = expect(pending).rejects.toMatchObject({ status: 401 });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    // A second 401 is not renewed again, so the sequence ends after one backoff.
    expect(sends.map(s => s.auth)).toEqual(['Bearer old', 'Bearer new', 'Bearer new']);
    expect(credential.renew).toHaveBeenCalledTimes(1);
  });
});
