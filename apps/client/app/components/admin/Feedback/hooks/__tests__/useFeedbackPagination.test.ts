import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { FEEDBACK_LIST_DEFAULT_LIMIT } from '@bike4mind/common';

vi.mock('@tanstack/react-router', async () => (await import('../../../__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from '../../../__tests__/fakeAdminRouter';
import { useFeedbackPagination } from '../useFeedbackPagination';

describe('useFeedbackPagination', () => {
  beforeEach(() => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback' }));
  });

  it('starts on page 1 at the default page size, with nothing in the URL', () => {
    const { result } = renderHook(() => useFeedbackPagination());

    expect(result.current).toMatchObject({ currentPage: 1, itemsPerPage: FEEDBACK_LIST_DEFAULT_LIMIT });
    expect(fakeAdminRouter.search).toEqual({ tab: 'feedback' });
  });

  it('restores the page and page size from the URL without rewriting it', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback', feedbackPage: 3, feedbackLimit: 50 }));
    const { result } = renderHook(() => useFeedbackPagination());

    expect(result.current).toMatchObject({ currentPage: 3, itemsPerPage: 50 });
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('writes a page change to the URL, replacing the history entry', () => {
    const { result } = renderHook(() => useFeedbackPagination());

    act(() => result.current.handlePageChange(2));

    expect(result.current.currentPage).toBe(2);
    expect(fakeAdminRouter.search).toEqual({ tab: 'feedback', feedbackPage: 2 });
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it('goes back to page 1 when the page size changes', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback', feedbackPage: 3 }));
    const { result } = renderHook(() => useFeedbackPagination());

    act(() => result.current.handleItemsPerPageChange(100));

    expect(fakeAdminRouter.search).toEqual({ tab: 'feedback', feedbackLimit: 100 });
  });

  it('keeps the pinned report and other params when paging', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback', feedbackId: 'f1', status: 'Closed' }));
    const { result } = renderHook(() => useFeedbackPagination());

    act(() => result.current.handlePageChange(2));

    expect(fakeAdminRouter.search).toEqual({ tab: 'feedback', feedbackId: 'f1', status: 'Closed', feedbackPage: 2 });
  });
});
