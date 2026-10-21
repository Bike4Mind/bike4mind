import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeedbackStatus } from '@bike4mind/common';
import type { FeedbackListParams } from '../../types';

const mocks = vi.hoisted(() => ({ getFeedbackFromServer: vi.fn() }));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackFromServer: mocks.getFeedbackFromServer,
  deleteFeedbackFromServer: vi.fn(),
  updateFeedbackOnServer: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useFeedbackOperations } from '../useFeedbackOperations';

const listParams = (page: number): FeedbackListParams => ({
  status: [FeedbackStatus.New],
  sort: 'desc',
  page,
  limit: 20,
});

const renderOperations = (initialParams: FeedbackListParams) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(({ params }) => useFeedbackOperations(params), {
    wrapper,
    initialProps: { params: initialParams },
  });
};

/** `totalSettled` gates FeedbackTab's out-of-range page clamp; a wrong `true` clamps a URL page early. */
describe('useFeedbackOperations totalSettled', () => {
  beforeEach(() => {
    mocks.getFeedbackFromServer.mockReset();
  });

  it('is false while the previous query total is still on screen, and true once the new one answers', async () => {
    let resolveSecond: (value: unknown) => void = () => undefined;
    mocks.getFeedbackFromServer
      .mockResolvedValueOnce({ items: [], total: 100, organizations: [] })
      .mockResolvedValueOnce({ items: [], total: 0, organizations: [] })
      .mockImplementationOnce(() => new Promise(resolve => (resolveSecond = resolve)));

    const { result, rerender } = renderOperations(listParams(1));
    await waitFor(() => expect(result.current.totalSettled).toBe(true));
    expect(result.current.total).toBe(100);

    rerender({ params: listParams(5) });

    expect(result.current.total).toBe(100);
    expect(result.current.totalSettled).toBe(false);

    resolveSecond({ items: [], total: 30 });
    await waitFor(() => expect(result.current.total).toBe(30));
    expect(result.current.totalSettled).toBe(true);
  });

  it('is true with no status checked, since the empty list is already the answer', () => {
    mocks.getFeedbackFromServer.mockResolvedValue({ items: [], total: 0, organizations: [] });

    const { result } = renderOperations({ sort: 'desc', page: 3, limit: 20 });

    expect(result.current.totalSettled).toBe(true);
  });
});
