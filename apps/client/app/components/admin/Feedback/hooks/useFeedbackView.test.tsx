import { act, renderHook } from '@testing-library/react';
import { FeedbackStatus } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('../../__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from '../../__tests__/fakeAdminRouter';
import { DEFAULT_FEEDBACK_VIEW } from '../feedbackTabSearch';
import { useFeedbackView } from './useFeedbackView';

const FEEDBACK_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  act(() => fakeAdminRouter.reset());
});

describe('useFeedbackView', () => {
  it('reads a bare feedback URL as the default view', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback' }));
    const { result } = renderHook(() => useFeedbackView());

    expect(result.current[0]).toEqual(DEFAULT_FEEDBACK_VIEW);
  });

  it('reads the view from the URL', () => {
    act(() =>
      fakeAdminRouter.reset({ tab: 'feedback', feedbackStatus: 'Closed', feedbackOrder: 'asc', feedbackPage: 3 })
    );
    const { result } = renderHook(() => useFeedbackView());

    expect(result.current[0]).toMatchObject({ sortAscending: true, page: 3 });
    expect(result.current[0].statusFilters[FeedbackStatus.Closed]).toBe(true);
    expect(result.current[0].statusFilters[FeedbackStatus.New]).toBe(false);
  });

  it('writes a patch and its page reset as one replace navigation, keeping the pinned report', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback', feedbackPage: 3, feedbackId: FEEDBACK_ID }));
    const { result } = renderHook(() => useFeedbackView());

    act(() => result.current[1]({ sortAscending: true, page: 1 }));

    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
    expect(fakeAdminRouter.search).toEqual({ tab: 'feedback', feedbackOrder: 'asc', feedbackId: FEEDBACK_ID });
  });

  it('computes a function patch from the URL at write time, so two writes in one tick compose', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback' }));
    const { result } = renderHook(() => useFeedbackView());

    act(() => {
      result.current[1]({ page: 2 });
      result.current[1](current => ({ page: current.page + 1 }));
    });

    expect(fakeAdminRouter.search).toEqual({ tab: 'feedback', feedbackPage: 3 });
  });

  it('drops the default view back to a bare URL', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback', feedbackOrder: 'asc' }));
    const { result } = renderHook(() => useFeedbackView());

    act(() => result.current[1]({ sortAscending: false }));

    expect(fakeAdminRouter.search).toEqual({ tab: 'feedback' });
  });
});
