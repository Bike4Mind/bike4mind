import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signupTimeseriesQueryKey, useSignupTimeseries } from './useSignupTimeseries';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));

const series = { bucket: 'day', buckets: [] };

function renderWithClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const result = renderHook(() => useSignupTimeseries('30d'), { wrapper });
  return { queryClient, ...result };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ data: series });
});

describe('useSignupTimeseries', () => {
  it('refetches when user queries are invalidated by prefix, as user mutations do', async () => {
    const { queryClient, result } = renderWithClient();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryState(signupTimeseriesQueryKey('30d'))?.isInvalidated).toBe(false);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    await act(() => queryClient.invalidateQueries({ queryKey: ['users'] }));

    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });

  it('is marked stale by a ["users"] invalidation even when not observed', async () => {
    const { queryClient, result, unmount } = renderWithClient();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    unmount();

    await queryClient.invalidateQueries({ queryKey: ['users'] });

    expect(queryClient.getQueryState(signupTimeseriesQueryKey('30d'))?.isInvalidated).toBe(true);
  });
});
