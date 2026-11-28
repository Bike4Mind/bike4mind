import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClock, NOW_TICK_MS } from './useNow';

afterEach(() => vi.useRealTimers());

describe('createClock', () => {
  it('is a single interval for every subscriber, no more often than every 30 seconds, gone with the last one', () => {
    vi.useFakeTimers({ now: 1_000 });
    const clock = createClock();
    expect(NOW_TICK_MS).toBeGreaterThanOrEqual(30_000);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = clock.subscribe(first);
    const stopSecond = clock.subscribe(second);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(NOW_TICK_MS - 1);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(1_000 + NOW_TICK_MS);

    stopFirst();
    expect(vi.getTimerCount()).toBe(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
  });
});
