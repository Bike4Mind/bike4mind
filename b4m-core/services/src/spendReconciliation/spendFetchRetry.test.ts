import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSpendJson, type ProviderSpendDiagnostic } from './spendFetchRetry';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const rateLimited = (headers: Record<string, string> = {}, type = 'rate_limit_error') =>
  Response.json({ error: { type } }, { status: 429, headers });
const success = () => Response.json({ total: 12 });
const request = (fetchFn: typeof fetch, options = {}) =>
  fetchSpendJson(
    'OpenAI',
    'https://example.test/costs',
    { headers: { Authorization: 'Bearer test-admin-key' } },
    fetchFn,
    options
  );
async function rejectsAfterTimers(pending: Promise<unknown>, message: string) {
  const assertion = expect(pending).rejects.toThrow(message);
  await vi.runAllTimersAsync();
  await assertion;
}

describe('spend GET retry', () => {
  it.each([
    ['retry-after', '2', 2000],
    ['retry-after-ms', '2500', 2500],
    ['retry-after', 'Wed, 01 Jul 2026 00:00:03 GMT', 3000],
    ['x-ratelimit-reset-requests', '1m2s', 62000],
    ['anthropic-ratelimit-requests-reset', '2026-07-01T00:00:04Z', 4000],
  ])('honors %s: %s', async (name, value, delay) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(rateLimited({ [name]: value }))
      .mockResolvedValueOnce(success());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    const pending = request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) });
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics[0].delayMs).toBe(delay);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ total: 12 });
  });
  it('uses jittered exponential fallback and bounds attempts', async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const fetchFn = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const diagnostics: ProviderSpendDiagnostic[] = [];
    await rejectsAfterTimers(
      request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) }),
      '503'
    );
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(diagnostics.map(value => value.delayMs)).toEqual([750, 1500, 3000, undefined]);
    expect(diagnostics[3].event).toBe('failure');
  });
  it('backs off a rate limit without a wait header on a longer, capped schedule', async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const fetchFn = vi.fn(async () => rateLimited());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    await rejectsAfterTimers(
      request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) }),
      'OpenAI API 429: http (attempt 6)'
    );
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(diagnostics.map(value => value.delayMs)).toEqual([3000, 6000, 12000, 24000, 30000, undefined]);
    expect(diagnostics[5].event).toBe('failure');
  });
  it('waits at least a minute in total before giving up on a rate limit', async () => {
    const fetchFn = vi.fn(async () => rateLimited());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    await rejectsAfterTimers(
      request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) }),
      '429'
    );
    expect(diagnostics.reduce((total, value) => total + (value.delayMs ?? 0), 0)).toBe(60_000);
  });
  it('recovers from a rate limit that lasts 30 seconds and sends no wait header', async () => {
    const startedAt = Date.now();
    const fetchFn = vi.fn(async () => (Date.now() - startedAt < 30_000 ? rateLimited() : success()));
    const pending = request(fetchFn);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ total: 12 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });
  it('keeps the short schedule when a rate limit names its own wait', async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(rateLimited({ 'retry-after': '1' }))
      .mockResolvedValueOnce(success());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    const pending = request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ total: 12 });
    expect(diagnostics[0].delayMs).toBe(1000);
  });
  it('uses the longer schedule when a rate limit names a zero wait', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(rateLimited({ 'retry-after': '0' }))
      .mockResolvedValueOnce(success());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    const pending = request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ total: 12 });
    expect(diagnostics[0].delayMs).toBe(2000);
  });
  it('fails a rate limit on the deadline rather than waiting past it', async () => {
    const fetchFn = vi.fn(async () => rateLimited());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    await rejectsAfterTimers(
      request(fetchFn, {
        deadlineMs: Date.now() + 10_000,
        onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value),
      }),
      'OpenAI API 429: deadline (attempt 3)'
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(diagnostics.map(value => value.delayMs)).toEqual([2000, 4000, undefined]);
  });
  it('reports the request limit headers of a rate limit without waiting on them', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        rateLimited({
          'x-ratelimit-limit-requests': '30',
          'x-ratelimit-remaining-requests': '0',
          'anthropic-ratelimit-requests-limit': 'private contents',
        })
      )
      .mockResolvedValueOnce(success());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    const pending = request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) });
    await vi.runAllTimersAsync();
    await pending;
    expect(diagnostics[0].rateLimitHeaders).toEqual({
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-remaining-requests': '0',
    });
    expect(diagnostics[0].delayMs).toBe(2000);
  });
  it.each([400, 401, 403])('does not retry HTTP %s', async status => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('sensitive response', { status }));
    await expect(request(fetchFn)).rejects.toThrow(`API ${status}`);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each(['insufficient_quota', 'billing_hard_limit_reached'])('does not retry quota error %s', async type => {
    const fetchFn = vi.fn().mockResolvedValue(rateLimited({}, type));
    await expect(request(fetchFn)).rejects.toThrow('quota');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('retries a rate limit whose message links to billing', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: 'rate_limit_exceeded',
              type: 'requests',
              message: 'Rate limit reached. Visit https://platform.openai.com/account/billing to add a payment method.',
            },
          },
          { status: 429 }
        )
      )
      .mockResolvedValueOnce(success());
    const pending = request(fetchFn);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ total: 12 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['5', (delay: number | undefined) => expect(delay).toBeLessThan(60_000)],
    ['0', (delay: number | undefined) => expect(delay).toBeGreaterThanOrEqual(60_000)],
  ])('reset header with remaining %s', async (remaining, check) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        rateLimited({ 'x-ratelimit-reset-requests': '1m', 'x-ratelimit-remaining-requests': remaining })
      )
      .mockResolvedValueOnce(success());
    const diagnostics: ProviderSpendDiagnostic[] = [];
    const pending = request(fetchFn, { onDiagnostic: (value: ProviderSpendDiagnostic) => diagnostics.push(value) });
    await vi.runAllTimersAsync();
    await pending;
    check(diagnostics[0].delayMs);
  });
  it('fails without shortening a provider delay beyond the remaining budget', async () => {
    const fetchFn = vi.fn().mockResolvedValue(rateLimited({ 'retry-after': '61' }));
    await expect(request(fetchFn, { deadlineMs: Date.now() + 60_000 })).rejects.toThrow('deadline');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not fetch after an already exhausted deadline', async () => {
    const fetchFn = vi.fn();
    await expect(request(fetchFn, { deadlineMs: Date.now() })).rejects.toThrow('deadline');
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('covers stalled response bodies and aborts before retrying', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async (_url, init) => {
        signal = init.signal;
        return { ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) };
      })
      .mockResolvedValueOnce(success());
    const pending = request(fetchFn);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ total: 12 });
  });
  it('bounds a stalled body by the absolute deadline', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    await rejectsAfterTimers(request(fetchFn, { deadlineMs: Date.now() + 1000 }), 'deadline');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retries transient network and server failures', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('secret network details'))
      .mockResolvedValueOnce(new Response('secret server body', { status: 503 }))
      .mockResolvedValueOnce(success());
    const pending = request(fetchFn);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ total: 12 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid JSON without retrying or leaking it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('test-admin-key'));
    await expect(request(fetchFn)).rejects.toThrow('invalid-json');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('emits only safe allowlisted diagnostics, even when the callback throws', async () => {
    const diagnostics: ProviderSpendDiagnostic[] = [];
    const fetchFn = vi.fn().mockResolvedValue(
      rateLimited({
        'request-id': 'test-admin-key',
        'retry-after': 'test-admin-key',
        'retry-after-ms': 'Wed, 01 Jul 2026 00:00:03 GMT',
        'x-secret': 'test-admin-key',
        'x-ratelimit-reset-tokens': 'private contents',
      })
    );
    const onDiagnostic = (value: ProviderSpendDiagnostic) => {
      diagnostics.push(value);
      throw new Error('logger failure');
    };
    await rejectsAfterTimers(request(fetchFn, { onDiagnostic }), '429');
    expect(JSON.stringify(diagnostics)).not.toMatch(/test-admin-key|private contents|logger failure/);
    expect(diagnostics[0].rateLimitHeaders).toEqual({});
    expect(diagnostics[0].requestId).toBeUndefined();
  });
  it('retains a safe request id for a final failure', async () => {
    const onDiagnostic = vi.fn();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('private body', { status: 400, headers: { 'x-request-id': 'req_safe-123' } }));
    await expect(request(fetchFn, { onDiagnostic })).rejects.toThrow('400');
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req_safe-123', event: 'failure', status: 400, attempt: 1 })
    );
  });
});

describe.each(['x-api-key', 'Authorization'])('invalid credential header %s', header => {
  it.each(['synthetic-admin-key\nsecond-line', 'synthetic-admin-key\0second-line', 'synthetic-admin-key\u0100'])(
    'sanitizes native Headers validation failures for %j',
    async credential => {
      const fetchFn = vi.fn();
      const diagnostics: ProviderSpendDiagnostic[] = [];
      const onDiagnostic = (value: ProviderSpendDiagnostic) => {
        diagnostics.push(value);
        throw new Error('logger failure');
      };
      const error = await fetchSpendJson(
        'OpenAI',
        'https://example.test/costs',
        { headers: { [header]: credential } },
        fetchFn,
        { onDiagnostic }
      ).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('OpenAI API: invalid-headers');
      expect(error.cause).toBeUndefined();
      expect(error.stack).not.toContain('synthetic-admin-key');
      expect(diagnostics).toEqual([
        { provider: 'OpenAI', event: 'failure', attempt: 1, reason: 'invalid-headers', rateLimitHeaders: {} },
      ]);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
