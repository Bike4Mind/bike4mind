import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  PENDING_GRANTS_QUERY_KEY,
  useAdminSignupGrantPendingList,
  useAdminSignupGrantPendingSummary,
} from './adminSignupGrant';
import { useSignupRiskReviewDecision } from './signupRiskReviews';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args), post: (...args: unknown[]) => apiPost(...args) },
}));

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'TestQueryClientWrapper';
  return { queryClient, Wrapper };
};

const page = (nextCursor: string | null) => ({ data: [], nextCursor, viewer: { canRelease: true } });

describe('useAdminSignupGrantPendingList', () => {
  beforeEach(() => apiGet.mockReset());

  it('sends only the set filters as query params, then the cursor for the next page', async () => {
    apiGet.mockResolvedValueOnce({ data: page('cursor-2') }).mockResolvedValueOnce({ data: page(null) });
    const { Wrapper } = setup();
    const { result } = renderHook(
      () =>
        useAdminSignupGrantPendingList({ status: 'held', heldReason: undefined, source: 'package', sort: 'remaining' }),
      { wrapper: Wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenNthCalledWith(1, '/api/admin/signup-grants/pending', {
      params: { status: 'held', source: 'package', sort: 'remaining' },
    });
    expect(result.current.hasNextPage).toBe(true);

    await act(() => result.current.fetchNextPage());
    expect(apiGet).toHaveBeenNthCalledWith(2, '/api/admin/signup-grants/pending', {
      params: { status: 'held', source: 'package', sort: 'remaining', cursor: 'cursor-2' },
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it('keys the list by its filters under the shared pending prefix', async () => {
    apiGet.mockResolvedValue({ data: page(null) });
    const { queryClient, Wrapper } = setup();
    const filters = { sort: 'oldest' as const };
    const { result } = renderHook(() => useAdminSignupGrantPendingList(filters), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      queryClient.getQueryCache().find({ queryKey: [...PENDING_GRANTS_QUERY_KEY, 'pending', filters] })
    ).toBeDefined();
  });
});

describe('useAdminSignupGrantPendingSummary', () => {
  beforeEach(() => apiGet.mockReset());

  it('reads the summary endpoint under the shared pending prefix', async () => {
    const summary = { accountsWithRemaining: 1, totalRemaining: 10, totalDripRemaining: 5, trickle: null, queue: null };
    apiGet.mockResolvedValue({ data: summary });
    const { queryClient, Wrapper } = setup();
    const { result } = renderHook(() => useAdminSignupGrantPendingSummary(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith('/api/admin/signup-grants/pending-summary');
    expect(result.current.data).toEqual(summary);
    expect(queryClient.getQueryData([...PENDING_GRANTS_QUERY_KEY, 'pending-summary'])).toEqual(summary);
  });
});

describe('risk review pending refresh', () => {
  beforeEach(() => {
    apiPost.mockReset();
  });

  it.each(['approve', 'reopen'] as const)('invalidates pending exposure after %s', async action => {
    apiPost.mockResolvedValue({ data: {} });
    const { queryClient, Wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSignupRiskReviewDecision(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync({ action, userIds: ['a'.repeat(24)], reason: 'Review decision' }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: PENDING_GRANTS_QUERY_KEY });
  });

  it('refreshes pending exposure when a request fails after a possible partial payout', async () => {
    apiPost.mockRejectedValue(new Error('Request interrupted'));
    const { queryClient, Wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSignupRiskReviewDecision(), { wrapper: Wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ action: 'approve', userIds: ['a'.repeat(24)], reason: 'Review decision' })
      ).rejects.toThrow('Request interrupted');
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: PENDING_GRANTS_QUERY_KEY });
  });
});
