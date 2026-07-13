import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVirtuosoPagination } from '../useVirtuosoPagination';

function makeItems(ids: string[]) {
  return ids.map(id => ({ id }));
}

describe('useVirtuosoPagination', () => {
  const defaultParams = {
    sessionId: 'session-1',
    filteredChatHistory: makeItems(['q1', 'q2', 'q3']),
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isStreaming: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default values', () => {
    const { result } = renderHook(() => useVirtuosoPagination(defaultParams));

    expect(result.current.firstItemIndex).toBe(100_000);
    expect(result.current.isAtBottom).toBe(true);
    expect(result.current.virtuosoRef.current).toBeNull();
  });

  it('should call fetchNextPage on handleStartReached when hasNextPage is true', () => {
    const fetchNextPage = vi.fn();
    const { result } = renderHook(() => useVirtuosoPagination({ ...defaultParams, hasNextPage: true, fetchNextPage }));

    act(() => {
      result.current.handleStartReached();
    });

    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it('should not call fetchNextPage on handleStartReached when hasNextPage is false', () => {
    const fetchNextPage = vi.fn();
    const { result } = renderHook(() => useVirtuosoPagination({ ...defaultParams, hasNextPage: false, fetchNextPage }));

    act(() => {
      result.current.handleStartReached();
    });

    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('should adjust firstItemIndex when older items are prepended', async () => {
    const initialItems = makeItems(['q1', 'q2', 'q3']);

    const { result, rerender } = renderHook(
      ({ items }) => useVirtuosoPagination({ ...defaultParams, filteredChatHistory: items }),
      { initialProps: { items: initialItems } }
    );

    expect(result.current.firstItemIndex).toBe(100_000);

    // Prepend older items (oldest id changes from 'q3' to 'q5')
    const withOlderItems = makeItems(['q1', 'q2', 'q3', 'q4', 'q5']);
    rerender({ items: withOlderItems });

    // firstItemIndex should decrease by the number of prepended items
    await waitFor(() => {
      expect(result.current.firstItemIndex).toBe(100_000 - 2);
    });
  });

  it('should NOT adjust firstItemIndex when new items are appended', () => {
    const initialItems = makeItems(['q1', 'q2', 'q3']);

    const { result, rerender } = renderHook(
      ({ items }) => useVirtuosoPagination({ ...defaultParams, filteredChatHistory: items }),
      { initialProps: { items: initialItems } }
    );

    expect(result.current.firstItemIndex).toBe(100_000);

    // Append new item at the beginning (newest), oldest id stays 'q3'
    const withNewItem = makeItems(['q0', 'q1', 'q2', 'q3']);
    act(() => {
      rerender({ items: withNewItem });
    });

    // firstItemIndex should NOT change - oldest item is the same
    expect(result.current.firstItemIndex).toBe(100_000);
  });

  it('should reset firstItemIndex when session changes', async () => {
    const initialItems = makeItems(['q1', 'q2', 'q3']);

    const { result, rerender } = renderHook(
      ({ sessionId, items }) => useVirtuosoPagination({ ...defaultParams, sessionId, filteredChatHistory: items }),
      { initialProps: { sessionId: 'session-1', items: initialItems } }
    );

    // Simulate prepend to change firstItemIndex
    const withOlderItems = makeItems(['q1', 'q2', 'q3', 'q4', 'q5']);
    rerender({ sessionId: 'session-1', items: withOlderItems });
    await waitFor(() => {
      expect(result.current.firstItemIndex).toBe(100_000 - 2);
    });

    // Change session - firstItemIndex resets
    rerender({ sessionId: 'session-2', items: makeItems(['a1']) });
    await waitFor(() => {
      expect(result.current.firstItemIndex).toBe(100_000);
    });
  });

  it('should allow setting isAtBottom externally', () => {
    const { result } = renderHook(() => useVirtuosoPagination(defaultParams));

    expect(result.current.isAtBottom).toBe(true);

    act(() => {
      result.current.setIsAtBottom(false);
    });

    expect(result.current.isAtBottom).toBe(false);
  });

  it('should store HTMLElement references via handleScrollerRef', () => {
    const { result } = renderHook(() => useVirtuosoPagination(defaultParams));

    const div = document.createElement('div');
    act(() => {
      result.current.handleScrollerRef(div);
    });

    expect(result.current.scrollerElementRef.current).toBe(div);
  });

  it('should ignore Window references in handleScrollerRef', () => {
    const { result } = renderHook(() => useVirtuosoPagination(defaultParams));

    act(() => {
      result.current.handleScrollerRef(window);
    });

    expect(result.current.scrollerElementRef.current).toBeNull();
  });
});

describe('useVirtuosoPagination auto-scroll follow behavior', () => {
  const baseParams = {
    sessionId: 'session-1',
    filteredChatHistory: makeItems(['q1', 'q2', 'q3']),
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  };

  // Manual RAF pump so the auto-scroll loop advances deterministically.
  let rafCbs: FrameRequestCallback[] = [];
  const flushRaf = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      const cbs = rafCbs;
      rafCbs = [];
      cbs.forEach(cb => cb(0));
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    rafCbs = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A scroller stub with settable scrollTop/scrollHeight and a scrollTo spy that
  // mirrors real behavior (updates scrollTop). `dims` lets a test grow content.
  function makeScroller(dims: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => dims.scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => dims.clientHeight, configurable: true });
    Object.defineProperty(el, 'scrollTop', {
      get: () => dims.scrollTop,
      set: (v: number) => {
        dims.scrollTop = v;
      },
      configurable: true,
    });
    el.scrollTo = vi.fn((opts?: ScrollToOptions | number) => {
      if (opts && typeof opts === 'object' && typeof opts.top === 'number') dims.scrollTop = opts.top;
    }) as typeof el.scrollTo;
    return el;
  }

  function touchEvent(type: string, clientY: number | null) {
    const e = new Event(type, { bubbles: true });
    Object.defineProperty(e, 'touches', {
      value: clientY == null ? [] : [{ clientY }],
      configurable: true,
    });
    return e;
  }

  function setupActive(dims: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    const el = makeScroller(dims);
    const { result, rerender } = renderHook(({ isActive }) => useVirtuosoPagination({ ...baseParams, isActive }), {
      initialProps: { isActive: false },
    });
    // Set the scroller ref BEFORE the effect runs with isActive=true, since the
    // effect captures scrollerElementRef.current at run time.
    act(() => {
      result.current.handleScrollerRef(el);
    });
    act(() => {
      rerender({ isActive: true });
    });
    return { el, dims };
  }

  it('pins to the bottom every frame while following and content is below the fold', () => {
    const { el, dims } = setupActive({ scrollHeight: 1000, clientHeight: 500, scrollTop: 0 });

    act(() => flushRaf());

    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1000 });
    expect(dims.scrollTop).toBe(1000);
  });

  it('detaches following on a touch drag-down (scroll-up gesture) and stops pinning', () => {
    const { el, dims } = setupActive({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });

    act(() => {
      el.dispatchEvent(touchEvent('touchstart', 400));
      el.dispatchEvent(touchEvent('touchmove', 450)); // finger moving down = scroll up
    });
    // User has scrolled up; content is now above the fold.
    dims.scrollTop = 200;
    act(() => flushRaf());

    expect(el.scrollTo).not.toHaveBeenCalled();
  });

  it('does not re-arm following within the old 50px band - only at the true bottom', () => {
    const { el, dims } = setupActive({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });

    // Desktop scroll-up detaches immediately.
    act(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
    });

    // A scroll event 30px from the bottom (inside the OLD 50px band) must NOT re-arm.
    dims.scrollTop = 470;
    act(() => {
      el.dispatchEvent(new Event('scroll'));
      flushRaf();
    });
    expect(el.scrollTo).not.toHaveBeenCalled();

    // Only a scroll to within the true-bottom epsilon re-arms following.
    dims.scrollTop = 499; // 1px from bottom
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    // New tokens grow the content; the re-armed loop pins again.
    dims.scrollHeight = 1400;
    act(() => flushRaf());
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1400 });
  });

  it('keeps following suppressed through momentum: a scroll near the bottom during touch does not re-arm', () => {
    const { el, dims } = setupActive({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });

    // Quick flick up that begins at the bottom.
    act(() => {
      el.dispatchEvent(touchEvent('touchstart', 400));
      el.dispatchEvent(touchEvent('touchmove', 420));
      el.dispatchEvent(touchEvent('touchend', null));
    });

    // Momentum emits scroll events (no touchmove) while still near the bottom.
    // Without the userInteracting guard, this would re-arm and snap back.
    dims.scrollTop = 490; // 10px from bottom, within the momentum settle window
    act(() => {
      el.dispatchEvent(new Event('scroll'));
      flushRaf();
    });
    expect(el.scrollTo).not.toHaveBeenCalled();

    // Momentum carries the view further up before the settle timer elapses.
    dims.scrollTop = 200;
    act(() => {
      vi.advanceTimersByTime(400); // TOUCH_SETTLE_MS
      flushRaf();
    });
    // Settled away from the bottom -> following stays detached.
    expect(el.scrollTo).not.toHaveBeenCalled();
  });

  it('re-arms following when a touch settles at the true bottom (scroll-to-bottom / drag back down)', () => {
    const { el, dims } = setupActive({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });

    act(() => {
      el.dispatchEvent(touchEvent('touchstart', 400));
      el.dispatchEvent(touchEvent('touchmove', 450)); // scroll up -> detach
      el.dispatchEvent(touchEvent('touchend', null));
    });

    // Finger released at the true bottom; settle timer re-arms following.
    dims.scrollTop = 500;
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // New content should now be pinned again.
    dims.scrollHeight = 1400;
    act(() => flushRaf());
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1400 });
  });
});
