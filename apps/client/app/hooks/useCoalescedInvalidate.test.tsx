import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COALESCED_INVALIDATE_DEBOUNCE_MS,
  COALESCED_INVALIDATE_MAX_WAIT_MS,
  useCoalescedInvalidate,
} from './useCoalescedInvalidate';

const mocks = vi.hoisted(() => {
  const invalidateQueries = vi.fn();
  return { invalidateQueries, queryClient: { invalidateQueries } };
});

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }));

describe('useCoalescedInvalidate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invalidateQueries.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invalidates once for a burst of calls', () => {
    const { result } = renderHook(() => useCoalescedInvalidate(['invites', 'inbox']));
    act(() => {
      for (let i = 0; i < 20; i++) result.current();
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS);
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['invites', 'inbox'] });
  });

  it('keeps one debounce across re-renders with an equal inline key', () => {
    const { result, rerender } = renderHook(({ id }) => useCoalescedInvalidate(['invites', 'projects', id]), {
      initialProps: { id: 'p1' },
    });
    act(() => {
      result.current();
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS - 50);
    });
    const first = result.current;
    rerender({ id: 'p1' });
    expect(result.current).toBe(first);
    // A per-render debounce would have cancelled the pending call on rerender.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('fires within maxWait during a steady stream of calls', () => {
    const { result } = renderHook(() => useCoalescedInvalidate(['invites', 'inbox']));
    act(() => {
      for (let t = 0; t < COALESCED_INVALIDATE_MAX_WAIT_MS; t += 100) {
        result.current();
        vi.advanceTimersByTime(100);
      }
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('invalidates the caller key as given, not a JSON round-trip of it', () => {
    const { result } = renderHook(() => useCoalescedInvalidate(['invites', undefined]));
    act(() => {
      result.current();
      vi.advanceTimersByTime(COALESCED_INVALIDATE_DEBOUNCE_MS);
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['invites', undefined] });
  });

  it('drops a pending invalidate when the key changes', () => {
    const { result, rerender } = renderHook(({ id }) => useCoalescedInvalidate(['invites', 'projects', id]), {
      initialProps: { id: 'p1' },
    });
    act(() => result.current());
    rerender({ id: 'p2' });
    act(() => {
      vi.runAllTimers();
    });
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });

  it('drops a pending invalidate on unmount', () => {
    const { result, unmount } = renderHook(() => useCoalescedInvalidate(['invites', 'inbox']));
    act(() => result.current());
    unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });
});
