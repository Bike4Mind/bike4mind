import { describe, it, expect, vi, beforeEach } from 'vitest';
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
