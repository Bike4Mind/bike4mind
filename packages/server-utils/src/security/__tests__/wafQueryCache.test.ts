// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wafQueryCache } from '../wafQueryCache';

beforeEach(() => {
  vi.useFakeTimers();
  wafQueryCache.invalidate();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('wafQueryCache ttl function', () => {
  it('derives a finite expiry from the fetched value', async () => {
    const fetcher = vi.fn(async () => ({ degraded: false }));
    const ttl = vi.fn((value: { degraded: boolean }) => (value.degraded ? 1_000 : 5_000));

    await wafQueryCache.getOrFetch('ttl-fn#finite', ttl, fetcher);
    expect(ttl).toHaveBeenCalledWith({ degraded: false });

    await vi.advanceTimersByTimeAsync(4_999);
    await wafQueryCache.getOrFetch('ttl-fn#finite', ttl, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    await wafQueryCache.getOrFetch('ttl-fn#finite', ttl, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refetches a degraded value after its short ttl and keeps a healthy one for its long ttl', async () => {
    const ttl = (value: { degraded: boolean }) => (value.degraded ? 1_000 : 5_000);
    const degraded = vi.fn(async () => ({ degraded: true }));
    const healthy = vi.fn(async () => ({ degraded: false }));

    await wafQueryCache.getOrFetch('ttl-fn#degraded', ttl, degraded);
    await wafQueryCache.getOrFetch('ttl-fn#healthy', ttl, healthy);
    await vi.advanceTimersByTimeAsync(1_001);
    await wafQueryCache.getOrFetch('ttl-fn#degraded', ttl, degraded);
    await wafQueryCache.getOrFetch('ttl-fn#healthy', ttl, healthy);

    expect(degraded).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
