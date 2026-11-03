import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AxiosError } from 'axios';

const mockUseGetUsers = vi.fn();
const mockMutateAsync = vi.fn();

vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: (...args: unknown[]) => mockUseGetUsers(...args),
}));
vi.mock('./useUpdateUserCredits', () => ({
  useUpdateUserCredits: () => ({ mutateAsync: mockMutateAsync }),
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

  it('sends a delta as creditDelta and a set as an absolute currentCredits', async () => {
    mockMutateAsync.mockResolvedValue({});
    const { result } = renderHook(() => useUserCreditsManager());

    await act(() => result.current.handleCreditAdjustment('u1', { kind: 'delta', delta: -50 }, ' why not '));
    expect(mockMutateAsync).toHaveBeenLastCalledWith({ userId: 'u1', creditDelta: -50, note: 'why not' });

    await act(() => result.current.handleCreditAdjustment('u1', { kind: 'set', balance: 0 }, 'zeroed'));
    expect(mockMutateAsync).toHaveBeenLastCalledWith({ userId: 'u1', currentCredits: 0, note: 'zeroed' });
  });

  it('reports the committed balance, not the request, so a floored deduction reads honestly', async () => {
    mockMutateAsync.mockResolvedValue({ currentCredits: -100 });
    const { result } = renderHook(() => useUserCreditsManager());

    await act(() => result.current.handleCreditAdjustment('u1', { kind: 'delta', delta: -50 }, 'penalty'));
    expect(result.current.notification.message).toBe('Requested -50 credits; balance is now -100');

    mockMutateAsync.mockResolvedValue({ currentCredits: 0 });
    await act(() => result.current.handleCreditAdjustment('u1', { kind: 'set', balance: 0 }, 'zeroed'));
    expect(result.current.notification.message).toBe('Requested balance 0; balance is now 0');
  });

  it("shows the server's reason when a credit update fails", async () => {
    const reason = 'Balance is already at or below zero; nothing to deduct';
    mockMutateAsync.mockRejectedValue(
      new AxiosError('Request failed', '400', undefined, undefined, {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: {} as never,
        data: { error: reason },
      })
    );
    const { result } = renderHook(() => useUserCreditsManager());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleCreditAdjustment('u1', { kind: 'delta', delta: -50 }, 'penalty');
    });
    expect(ok).toBe(false);
    expect(result.current.notification.message).toBe(reason);
    expect(result.current.notification.color).toBe('danger');
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
