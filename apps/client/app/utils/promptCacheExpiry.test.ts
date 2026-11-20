// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptCacheExpiresAt, usePromptCacheExpired } from './promptCacheExpiry';

const START = Date.UTC(2026, 9, 29, 12, 0, 0);
const MIN = 60_000;

describe('promptCacheExpiresAt', () => {
  it('runs the TTL from the end of the turn, where its last request started', () => {
    const turn = { timestamp: new Date(START).toISOString(), turnTiming: { queueMs: 200, totalMs: 40_000 } };
    expect(promptCacheExpiresAt(turn)).toBe(START + 40_000 + 5 * MIN);
  });

  it('uses the TTL the turn recorded', () => {
    const turn = {
      timestamp: START,
      turnTiming: { queueMs: 0, totalMs: 1_000 },
      promptMeta: { tokenUsage: { promptCacheTtl: '1h' } },
    };
    expect(promptCacheExpiresAt(turn)).toBe(START + 1_000 + 60 * MIN);
  });

  it('falls back to the first request, then the turn start, without a total', () => {
    expect(promptCacheExpiresAt({ timestamp: START, turnTiming: { queueMs: 300, contextBuildMs: 700 } })).toBe(
      START + 1_000 + 5 * MIN
    );
    expect(promptCacheExpiresAt({ timestamp: START })).toBe(START + 5 * MIN);
  });

  it('is null without a usable time', () => {
    expect(promptCacheExpiresAt({})).toBeNull();
    expect(promptCacheExpiresAt({ timestamp: 'not a date' })).toBeNull();
  });
});

describe('usePromptCacheExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => vi.useRealTimers());

  it('flips at the expiry moment from one timer', () => {
    const { result } = renderHook(() => usePromptCacheExpired(START + 5 * MIN));
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(5 * MIN - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is expired at once for a past expiry and never without one', () => {
    expect(renderHook(() => usePromptCacheExpired(START - 1)).result.current).toBe(true);
    expect(renderHook(() => usePromptCacheExpired(null)).result.current).toBe(false);
  });

  it('goes back to warm when a newer turn moves the expiry', () => {
    const { result, rerender } = renderHook(({ at }) => usePromptCacheExpired(at), {
      initialProps: { at: START + MIN },
    });
    act(() => vi.advanceTimersByTime(MIN));
    expect(result.current).toBe(true);
    rerender({ at: START + 10 * MIN });
    expect(result.current).toBe(false);
  });
});
