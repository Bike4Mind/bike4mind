import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { formatCountdown, useOtcRateLimit, waitMinutes } from './useOtcRateLimit';

describe('useOtcRateLimit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ignores errors that are not a 429', () => {
    const { result } = renderHook(() => useOtcRateLimit());
    let handled = true;
    act(() => {
      handled = result.current.handleError({ code: 'CLIENT_ERROR_500', retryAfterSeconds: 30 });
    });
    expect(handled).toBe(false);
    expect(result.current.secondsLeft).toBe(0);
  });

  it('counts the Retry-After wait down to zero and keeps the announced total fixed', () => {
    const { result } = renderHook(() => useOtcRateLimit());
    act(() => {
      result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds: 3 });
    });
    expect(result.current.secondsLeft).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.secondsLeft).toBe(2);
    expect(result.current.initialSeconds).toBe(3);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.initialSeconds).toBe(0);
  });

  it.each([undefined, -5, Number.NaN])('falls back to 60s when Retry-After is %s', retryAfterSeconds => {
    const { result } = renderHook(() => useOtcRateLimit());
    act(() => {
      result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds });
    });
    expect(result.current.secondsLeft).toBe(60);
  });

  it('does not lock when Retry-After is 0 (server says retry now)', () => {
    const { result } = renderHook(() => useOtcRateLimit());
    let handled = true;
    act(() => {
      handled = result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds: 0 });
    });
    expect(handled).toBe(false);
    expect(result.current.secondsLeft).toBe(0);
  });

  it('caps an absurd Retry-After at one hour', () => {
    const { result } = renderHook(() => useOtcRateLimit());
    act(() => {
      result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds: 99999999 });
    });
    expect(result.current.secondsLeft).toBe(3600);
  });

  it('flags a wait above the cap so the notice does not promise a duration', () => {
    const { result } = renderHook(() => useOtcRateLimit());
    act(() => {
      result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds: 7200 });
    });
    expect(result.current.capped).toBe(true);
    act(() => {
      result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds: 30 });
    });
    expect(result.current.capped).toBe(false);
  });

  it('replaces the server "please wait" message when Retry-After is 0', () => {
    const { result } = renderHook(() => useOtcRateLimit());
    const error = {
      code: 'CLIENT_ERROR_429',
      retryAfterSeconds: 0,
      message: 'Please wait before requesting another code.',
    };
    expect(result.current.errorMessage(error, 'x')).toBe('auth.rateLimitRetryNow');
    expect(result.current.errorMessage({ code: 'CLIENT_ERROR_500', message: 'boom' }, 'x')).toBe('boom');
    expect(result.current.errorMessage({}, 'fallback')).toBe('fallback');
  });

  it('restarts rather than stacking timers on a second 429', () => {
    const { result } = renderHook(() => useOtcRateLimit());
    act(() => {
      result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds: 10 });
    });
    act(() => {
      result.current.handleError({ code: 'CLIENT_ERROR_429', retryAfterSeconds: 10 });
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.secondsLeft).toBe(9);
  });
});

describe('formatting', () => {
  it('formats the countdown as m:ss', () => {
    expect(formatCountdown(529)).toBe('8:49');
    expect(formatCountdown(5)).toBe('0:05');
  });

  it('rounds minutes up and returns null under a minute', () => {
    expect(waitMinutes(59)).toBeNull();
    expect(waitMinutes(61)).toBe(2);
  });
});
