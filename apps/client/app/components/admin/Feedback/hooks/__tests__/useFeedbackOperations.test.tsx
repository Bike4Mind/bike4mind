import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeedbackStatus, FeedbackType, type PromptMeta } from '@bike4mind/common';
import type { FeedbackListParams, IExtendedFeedbackDocument } from '../../types';

const mocks = vi.hoisted(() => ({
  getFeedbackFromServer: vi.fn(),
  updateFeedbackOnServer: vi.fn(),
  deleteFeedbackFromServer: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackFromServer: mocks.getFeedbackFromServer,
  deleteFeedbackFromServer: mocks.deleteFeedbackFromServer,
  updateFeedbackOnServer: mocks.updateFeedbackOnServer,
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));

import { useFeedbackOperations } from '../useFeedbackOperations';
import { FEEDBACK_TRENDS_QUERY_KEY } from '../../queryKeys';

const listParams = (page: number): FeedbackListParams => ({
  status: [FeedbackStatus.New],
  sort: 'desc',
  page,
  limit: 20,
});

const renderOperations = (
  initialParams: FeedbackListParams,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) => {
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

describe('useFeedbackOperations organizations query', () => {
  it('asks the server for the facet alone', async () => {
    mocks.getFeedbackFromServer.mockReset();
    mocks.getFeedbackFromServer.mockResolvedValue({ items: [], total: 0, organizations: ['Acme'] });

    const { result } = renderOperations(listParams(1));

    await waitFor(() => expect(result.current.organizations).toEqual(['Acme']));
    expect(mocks.getFeedbackFromServer).toHaveBeenCalledWith(expect.objectContaining({ facetsOnly: true }));
  });
});

describe('useFeedbackOperations isError', () => {
  beforeEach(() => {
    mocks.getFeedbackFromServer.mockReset();
  });

  it('reports a failed list request', async () => {
    mocks.getFeedbackFromServer.mockImplementation((params: FeedbackListParams) =>
      params.facetsOnly
        ? Promise.resolve({ items: [], total: 0, organizations: [] })
        : Promise.reject(new Error('list failed'))
    );

    const { result } = renderOperations(listParams(1));

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('stays false with no status checked, since no list request is made', async () => {
    mocks.getFeedbackFromServer.mockRejectedValue(new Error('list failed'));

    const { result } = renderOperations({ sort: 'desc', page: 1, limit: 25 });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isError).toBe(false);
  });
});

describe('useFeedbackOperations handleStatusChange', () => {
  it('names the type, reporter and new status label in the toast', async () => {
    mocks.getFeedbackFromServer.mockResolvedValue({ items: [], total: 0, organizations: [] });
    mocks.updateFeedbackOnServer.mockResolvedValue({ ok: true });
    const item: IExtendedFeedbackDocument = {
      id: 'fb-1',
      _id: 'fb-1',
      userId: 'user-1',
      status: FeedbackStatus.New,
      username: 'reporter',
      userEmail: 'reporter@example.com',
      customerService: '',
      organization: 'Unknown',
      type: FeedbackType.FEEDBACK,
      promptMeta: {} as unknown as PromptMeta,
      subject: 'product',
      contentStored: true,
      content: 'Short report',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    };

    const { result } = renderOperations(listParams(1));
    await act(() => result.current.handleStatusChange(item, FeedbackStatus.InProgress));

    expect(mocks.toastSuccess).toHaveBeenCalledWith('Feedback from reporter set to In progress', expect.anything());
    expect(mocks.updateFeedbackOnServer).toHaveBeenCalledTimes(1);
    const [id, payload] = mocks.updateFeedbackOnServer.mock.calls[0];
    expect(id).toBe('fb-1');
    expect(payload).toEqual({ userId: 'user-1', username: 'reporter', status: FeedbackStatus.InProgress });
  });

  it('names the report by its type rather than quoting its text, which may be empty', async () => {
    mocks.getFeedbackFromServer.mockResolvedValue({ items: [], total: 0, organizations: [] });
    mocks.updateFeedbackOnServer.mockResolvedValue({ ok: true });
    const item = {
      _id: 'fb-2',
      userId: 'user-2',
      status: FeedbackStatus.New,
      username: 'rater',
      type: FeedbackType.THUMBS_DOWN,
      content: '',
    } as unknown as IExtendedFeedbackDocument;

    const { result } = renderOperations(listParams(1));
    await act(() => result.current.handleStatusChange(item, FeedbackStatus.Closed));

    expect(mocks.toastSuccess).toHaveBeenCalledWith('Thumbs down from rater set to Closed', expect.anything());
  });
});

describe('useFeedbackOperations trends refresh', () => {
  const item = {
    _id: 'fb-3',
    userId: 'user-3',
    status: FeedbackStatus.New,
    username: 'rater',
    type: FeedbackType.FEEDBACK,
    content: 'x',
  } as unknown as IExtendedFeedbackDocument;

  const setup = () => {
    mocks.getFeedbackFromServer.mockResolvedValue({ items: [item], total: 1, organizations: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    return { ...renderOperations(listParams(1), queryClient), invalidate };
  };

  it('refetches the trends after a status change', async () => {
    mocks.updateFeedbackOnServer.mockResolvedValue({ ok: true });
    const { result, invalidate } = setup();
    await waitFor(() => expect(result.current.feedback).toHaveLength(1));

    await act(() => result.current.handleStatusChange(item, FeedbackStatus.Closed));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: FEEDBACK_TRENDS_QUERY_KEY });
  });

  it('refetches the trends after a delete', async () => {
    mocks.deleteFeedbackFromServer.mockResolvedValue({ ok: true });
    const { result, invalidate } = setup();
    await waitFor(() => expect(result.current.feedback).toHaveLength(1));

    act(() => result.current.handleDeleteFeedbackClick(item));
    await act(() => result.current.confirmDeleteFeedback());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: FEEDBACK_TRENDS_QUERY_KEY });
  });
});
