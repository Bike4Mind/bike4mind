import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import type { FeedbackListParams, IExtendedFeedbackDocument } from '../../types';

const mocks = vi.hoisted(() => ({
  getFeedbackFromServer: vi.fn(),
  updateFeedbackStatusOnServer: vi.fn(),
  deleteFeedbackFromServer: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackFromServer: mocks.getFeedbackFromServer,
  deleteFeedbackFromServer: mocks.deleteFeedbackFromServer,
  updateFeedbackStatusOnServer: mocks.updateFeedbackStatusOnServer,
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));

import { UndoToastProvider } from '../../../shared/UndoToast';

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
    <QueryClientProvider client={queryClient}>
      <UndoToastProvider>{children}</UndoToastProvider>
    </QueryClientProvider>
  );
  return {
    ...renderHook(({ params }) => useFeedbackOperations(params), {
      wrapper,
      initialProps: { params: initialParams },
    }),
    queryClient,
  };
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

const statusResponse = (status: FeedbackStatus, previousStatus: FeedbackStatus) => ({
  status,
  previousStatus,
  handledBy: 'admin-1',
  handledAt: '2024-01-02T00:00:00.000Z',
  auditEntryId: 'audit-1',
});

const reportItem = {
  _id: 'fb-1',
  userId: 'user-1',
  status: FeedbackStatus.New,
  username: 'reporter',
  type: FeedbackType.FEEDBACK,
  content: 'Short report',
} as unknown as IExtendedFeedbackDocument;

describe('useFeedbackOperations handleStatusChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFeedbackFromServer.mockResolvedValue({ items: [], total: 0, organizations: [] });
  });

  it('sends only the status with the status the admin saw, then offers Undo', async () => {
    mocks.updateFeedbackStatusOnServer.mockResolvedValue(statusResponse(FeedbackStatus.InProgress, FeedbackStatus.New));

    const { result } = renderOperations(listParams(1));
    await act(() => result.current.handleStatusChange(reportItem, FeedbackStatus.InProgress));

    expect(mocks.updateFeedbackStatusOnServer).toHaveBeenCalledWith('fb-1', {
      status: FeedbackStatus.InProgress,
      expectedStatus: FeedbackStatus.New,
    });
    expect(screen.getByTestId('undo-toast-message').textContent).toBe('Feedback from reporter set to In progress');
  });

  it('names the report by its type rather than quoting its text, which may be empty', async () => {
    mocks.updateFeedbackStatusOnServer.mockResolvedValue(statusResponse(FeedbackStatus.Closed, FeedbackStatus.New));
    const item = { ...reportItem, username: 'rater', type: FeedbackType.THUMBS_DOWN, content: '' };

    const { result } = renderOperations(listParams(1));
    await act(() => result.current.handleStatusChange(item, FeedbackStatus.Closed));
    expect(mocks.updateFeedbackStatusOnServer).not.toHaveBeenCalled();
    expect(result.current.feedbackToClose).toBe(item);
    await act(() => result.current.confirmClose({ resolution: 'fixed' }));

    expect(screen.getByTestId('undo-toast-message').textContent).toBe('Thumbs down from rater set to Closed');
  });

  it('Undo restores the previous status and names the audit entry it reverses', async () => {
    mocks.updateFeedbackStatusOnServer
      .mockResolvedValueOnce(statusResponse(FeedbackStatus.Closed, FeedbackStatus.New))
      .mockResolvedValueOnce({ ...statusResponse(FeedbackStatus.New, FeedbackStatus.Closed), auditEntryId: 'audit-2' });

    const { result } = renderOperations(listParams(1));
    await act(() => result.current.handleStatusChange(reportItem, FeedbackStatus.Closed));
    await act(() => result.current.confirmClose({ resolution: 'fixed' }));
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(mocks.updateFeedbackStatusOnServer).toHaveBeenLastCalledWith('fb-1', {
        status: FeedbackStatus.New,
        expectedStatus: FeedbackStatus.Closed,
        undoOf: 'audit-1',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('undo-toast')).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Feedback from reporter set back to New', expect.anything());
  });

  it('links the toast to the audit entry', async () => {
    mocks.updateFeedbackStatusOnServer.mockResolvedValue(statusResponse(FeedbackStatus.Closed, FeedbackStatus.New));

    const { result } = renderOperations(listParams(1));
    await act(() => result.current.handleStatusChange(reportItem, FeedbackStatus.Closed));
    await act(() => result.current.confirmClose({ resolution: 'fixed' }));
    fireEvent.click(screen.getByTestId('undo-toast-audit-btn'));

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: expect.objectContaining({ tab: 'audit-log', entryId: 'audit-1' }),
    });
  });

  it('reports a rejected change and offers no Undo', async () => {
    mocks.updateFeedbackStatusOnServer.mockRejectedValue(new Error('This report is already Closed.'));

    const { result } = renderOperations(listParams(1));
    await act(() => result.current.handleStatusChange(reportItem, FeedbackStatus.InProgress));

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('already Closed'), expect.anything());
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });
});

describe('useFeedbackOperations confirmDeleteFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFeedbackFromServer.mockResolvedValue({ items: [reportItem], total: 1, organizations: [] });
  });

  it('sends the reason and rejects on failure so the dialog stays open', async () => {
    mocks.deleteFeedbackFromServer.mockRejectedValueOnce(new Error('A reason is required')).mockResolvedValue({});

    const { result, queryClient } = renderOperations(listParams(1));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(result.current.feedback).toHaveLength(1));
    act(() => result.current.handleDeleteFeedbackClick(reportItem));

    await expect(act(() => result.current.confirmDeleteFeedback('Duplicate report'))).rejects.toThrow();
    expect(result.current.openDeleteFeedbackModal).toBe(true);

    await act(() => result.current.confirmDeleteFeedback('Duplicate report'));
    expect(mocks.deleteFeedbackFromServer).toHaveBeenLastCalledWith('fb-1', 'Duplicate report');
    expect(result.current.openDeleteFeedbackModal).toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'action-counts'] });
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
    mocks.updateFeedbackStatusOnServer.mockResolvedValue(statusResponse(FeedbackStatus.Closed, FeedbackStatus.New));
    const { result, invalidate } = setup();
    await waitFor(() => expect(result.current.feedback).toHaveLength(1));

    await act(() => result.current.handleStatusChange(item, FeedbackStatus.Closed));
    await act(() => result.current.confirmClose({ resolution: 'fixed' }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: FEEDBACK_TRENDS_QUERY_KEY });
  });

  it('refetches the trends after a delete', async () => {
    mocks.deleteFeedbackFromServer.mockResolvedValue({ ok: true });
    const { result, invalidate } = setup();
    await waitFor(() => expect(result.current.feedback).toHaveLength(1));

    act(() => result.current.handleDeleteFeedbackClick(item));
    await act(() => result.current.confirmDeleteFeedback('Duplicate report'));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: FEEDBACK_TRENDS_QUERY_KEY });
  });
});
