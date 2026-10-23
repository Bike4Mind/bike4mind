// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIRST_SIGNUP_SESSION_KEY,
  FIRST_SIGNUP_SESSION_TTL_MS,
  markFirstSignupSession,
} from '@client/app/utils/firstSignupSession';
import { useFirstSignupSession } from './useFirstSignupSession';

describe('useFirstSignupSession', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('is true when marked for the user', () => {
    markFirstSignupSession('user-1');
    const { result } = renderHook(() => useFirstSignupSession('user-1'));
    expect(result.current).toBe(true);
  });

  it('is false for a different user without clearing the marker during render', () => {
    markFirstSignupSession('user-1');
    const { result } = renderHook(() => useFirstSignupSession(undefined));
    expect(result.current).toBe(false);
    expect(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY)).not.toBeNull();
  });

  it('flips false when the TTL elapses', () => {
    markFirstSignupSession('user-1');
    const { result } = renderHook(() => useFirstSignupSession('user-1'));
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(FIRST_SIGNUP_SESSION_TTL_MS + 1);
    });
    expect(result.current).toBe(false);
  });

  it('flips false when another tab removes the marker', () => {
    markFirstSignupSession('user-1');
    const { result } = renderHook(() => useFirstSignupSession('user-1'));
    expect(result.current).toBe(true);
    act(() => {
      localStorage.removeItem(FIRST_SIGNUP_SESSION_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: FIRST_SIGNUP_SESSION_KEY }));
    });
    expect(result.current).toBe(false);
  });

  it('picks up a marker written before userId changes from undefined to the id', () => {
    const { result, rerender } = renderHook(({ id }) => useFirstSignupSession(id), {
      initialProps: { id: undefined as string | undefined },
    });
    expect(result.current).toBe(false);
    markFirstSignupSession('user-1');
    rerender({ id: 'user-1' });
    expect(result.current).toBe(true);
  });
});
