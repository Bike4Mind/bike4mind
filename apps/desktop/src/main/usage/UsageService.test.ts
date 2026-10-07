import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { describe, expect, it, vi } from 'vitest';
import { UsageService } from './UsageService';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

const USAGE_BODY = {
  overTime: [{ day: '2026-10-07', creditsCharged: 50, requests: 5 }],
  byModel: [{ provider: 'anthropic', model: 'claude-opus-5', creditsCharged: 50, requests: 5 }],
  byFeature: [{ feature: 'chat', creditsCharged: 50, requests: 5 }],
  bySource: [{ source: 'desktop', creditsSpent: 50, requests: 5 }],
};

function service(get: ReturnType<typeof vi.fn>, options: { userId?: string | null; now?: () => number } = {}) {
  const { userId = 'user-1', now = () => NOW } = options;
  return new UsageService({
    logger: { warn: () => {} },
    getApiClient: () => (userId ? ({ get } as unknown as AuthenticatedApiClient) : null),
    getUserId: () => userId,
    now,
  });
}

function respond(url: string): unknown {
  return url.startsWith('/api/credits/transactions')
    ? [{ createdAt: '2026-10-07T11:30:00.000Z', credits: -12 }]
    : USAGE_BODY;
}

describe('UsageService', () => {
  it('asks only for the signed-in account, by id', async () => {
    const get = vi.fn(respond);
    await service(get).history('last-30-days');
    expect(get).toHaveBeenCalledWith('/api/usage?ownerType=User&ownerId=user-1&days=30');
  });

  it('buckets the short window by hour out of the ledger', async () => {
    const get = vi.fn(respond);
    const result = await service(get).history('last-24-hours');

    expect(get).toHaveBeenCalledWith('/api/credits/transactions?days=1&type=deducted');
    expect(result.ok && result.usage.granularity).toBe('hour');
    expect(result.ok && result.usage.bars).toHaveLength(24);
    expect(result.ok && result.usage.creditsSpent).toBe(12);
  });

  // The server's own rollup is the only thing that can answer a month; it is day-granular.
  it('uses the server rollup for the long window and does not read the ledger', async () => {
    const get = vi.fn(respond);
    const result = await service(get).history('last-30-days');

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.ok && result.usage.granularity).toBe('day');
    expect(result.ok && result.usage.creditsSpent).toBe(50);
  });

  it('carries all three breakdown cuts, which is what answers where the credits went', async () => {
    const result = await service(vi.fn(respond)).history('last-30-days');
    expect(result.ok && result.usage.byModel[0].label).toBe('claude-opus-5');
    expect(result.ok && result.usage.byFeature[0].label).toBe('Chat');
    expect(result.ok && result.usage.bySource[0].label).toBe('Desktop');
  });

  // Zero spend is an answer, not a failure: the screen draws an empty window, not an error.
  it('reports an empty window as a successful read', async () => {
    const result = await service(vi.fn(() => ({}))).history('last-30-days');
    expect(result.ok).toBe(true);
    expect(result.ok && result.usage.creditsSpent).toBe(0);
    expect(result.ok && result.usage.bars.length).toBeGreaterThan(0);
  });

  it('does not reach the network at all when signed out', async () => {
    const get = vi.fn();
    const result = await service(get, { userId: null }).history('last-30-days');
    expect(result).toEqual({ ok: false, error: 'Sign in to see your usage.' });
    expect(get).not.toHaveBeenCalled();
  });

  it('reports a failed read as a failure rather than as a window that spent nothing', async () => {
    const get = vi.fn().mockRejectedValue(new Error('403'));
    const result = await service(get).history('last-30-days');
    expect(result.ok).toBe(false);
  });

  it('refuses a window it does not know instead of asking the server for undefined days', async () => {
    const get = vi.fn(respond);
    const result = await service(get).history('last-decade' as 'last-30-days');
    expect(result.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('serves a repeat ask from the cache, and goes back to the server when forced', async () => {
    const get = vi.fn(respond);
    const usage = service(get);

    await usage.history('last-30-days');
    await usage.history('last-30-days');
    expect(get).toHaveBeenCalledTimes(1);

    await usage.history('last-30-days', true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('caches each window separately, so switching tabs does not serve the other one', async () => {
    const get = vi.fn(respond);
    const usage = service(get);

    await usage.history('last-30-days');
    const short = await usage.history('last-24-hours');
    expect(short.ok && short.usage.window).toBe('last-24-hours');
  });

  it('lets the cache lapse', async () => {
    const get = vi.fn(respond);
    let clock = NOW;
    const usage = service(get, { now: () => clock });

    await usage.history('last-30-days');
    clock += 120_000;
    await usage.history('last-30-days');
    expect(get).toHaveBeenCalledTimes(2);
  });

  // A cached failure would leave the screen's own Try again doing nothing for a minute.
  it('never holds on to a failure', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('503')).mockImplementation(respond);
    const usage = service(get);

    expect((await usage.history('last-30-days')).ok).toBe(false);
    expect((await usage.history('last-30-days')).ok).toBe(true);
  });

  it('treats a ledger that answered with the wrong shape as a failed read', async () => {
    const get = vi.fn((url: string) => (url.startsWith('/api/credits') ? { error: 'nope' } : USAGE_BODY));
    const result = await service(get).history('last-24-hours');
    expect(result.ok).toBe(false);
  });
});
