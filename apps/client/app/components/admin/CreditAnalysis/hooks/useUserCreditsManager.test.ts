import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockUseGetUsers = vi.fn();

vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: (...args: unknown[]) => mockUseGetUsers(...args),
}));
vi.mock('./useUpdateUserCredits', () => ({
  useUpdateUserCredits: () => ({ mutateAsync: vi.fn() }),
}));

import { useUserCreditsManager } from './useUserCreditsManager';

const lastParams = () => mockUseGetUsers.mock.calls.at(-1)?.[0];

describe('useUserCreditsManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockUseGetUsers.mockReturnValue({
      data: { users: [], totalUsers: 373, totalPages: 19 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('requests server-side sort by currentCredits (default highest first)', () => {
    renderHook(() => useUserCreditsManager());
    expect(lastParams()).toMatchObject({ sortField: 'currentCredits', sortOrder: 'desc' });
  });

  it('pushes the sort direction to the server and returns to page 1', () => {
    const { result } = renderHook(() => useUserCreditsManager());

    act(() => result.current.setCurrentPage(5));
    expect(result.current.currentPage).toBe(5);

    act(() => result.current.setSortDirection('asc'));

    expect(result.current.currentPage).toBe(1);
    expect(lastParams()).toMatchObject({ sortField: 'currentCredits', sortOrder: 'asc', page: 1 });
  });

  it('passes the search term to the server (debounced) and returns to page 1', () => {
    const { result } = renderHook(() => useUserCreditsManager());

    act(() => result.current.setCurrentPage(5));
    act(() => result.current.setSearchQuery('ada'));

    // Input reflects the term immediately and the page resets, but the query waits for debounce.
    expect(result.current.searchQuery).toBe('ada');
    expect(result.current.currentPage).toBe(1);
    expect(lastParams()?.search).toBeUndefined();

    act(() => vi.advanceTimersByTime(300));

    expect(lastParams()?.search).toBe('ada');
  });
});
