import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';
import {
  feedbackRollupQueryKey,
  feedbackSessionQueryKey,
  useFeedbackRollup,
  useGetFeedbackBySessionId,
} from './feedback';

/**
 * Direct coverage of the hook backing the in-thread "Reported" annotation - every consumer test
 * (MessageContent.gating.test.tsx, .rapidReplyOrder.test.tsx) mocks this module away, so the
 * request shape and the optimistic-id guard had no test of their own before this file.
 */

const getFeedbackFromServer = vi.fn();
const getFeedbackRollupFromServer = vi.fn();
vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackFromServer: (...args: unknown[]) => getFeedbackFromServer(...args),
  getFeedbackRollupFromServer: (...args: unknown[]) => getFeedbackRollupFromServer(...args),
}));

const mocks = vi.hoisted(() => ({ currentUser: null as { id: string } | null }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mocks.currentUser }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: new QueryClient() }, children);

beforeEach(() => {
  getFeedbackFromServer.mockReset();
  getFeedbackRollupFromServer.mockReset();
  mocks.currentUser = { id: 'user-1' };
});

describe('useGetFeedbackBySessionId', () => {
  it("requests only this user's turn-level reports on this session, newest first, uncapped by the UI", async () => {
    getFeedbackFromServer.mockResolvedValue({
      items: [{ id: 'f1' }],
      total: 1,
      page: 1,
      limit: FEEDBACK_LIST_MAX_LIMIT,
    });

    const { result } = renderHook(() => useGetFeedbackBySessionId('session-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // userId is load-bearing, not redundant with the endpoint's CASL scope: an admin's read grant
    // is unconditional, so without it this returns every user's reports on the session and the
    // annotation renders a stranger's report as "You reported this message".
    expect(getFeedbackFromServer).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 'session-1',
      subject: 'turn',
      sort: 'desc',
      page: 1,
      limit: FEEDBACK_LIST_MAX_LIMIT,
    });
    // Unwraps to the item list, not the paginated envelope - consumers diff on `.data.length`.
    expect(result.current.data).toEqual([{ id: 'f1' }]);
  });

  it('does not fire for an optimistic (not-yet-persisted) session id', () => {
    renderHook(() => useGetFeedbackBySessionId('optimistic-session-abc'), { wrapper });

    expect(getFeedbackFromServer).not.toHaveBeenCalled();
  });

  it('honors an explicit enabled:false regardless of the session id', () => {
    renderHook(() => useGetFeedbackBySessionId('session-1', { enabled: false }), { wrapper });

    expect(getFeedbackFromServer).not.toHaveBeenCalled();
  });

  it('does not fire before the user is hydrated, rather than reading unscoped', () => {
    mocks.currentUser = null;

    renderHook(() => useGetFeedbackBySessionId('session-1'), { wrapper });

    expect(getFeedbackFromServer).not.toHaveBeenCalled();
  });

  it('keys the cache on the user so a second account does not inherit the first ones annotations', () => {
    expect(feedbackSessionQueryKey('session-1', 'user-1')).not.toEqual(feedbackSessionQueryKey('session-1', 'user-2'));
  });
});

describe('useFeedbackRollup', () => {
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };

  it('sends only the window - never a userId, which the server derives from the session', async () => {
    getFeedbackRollupFromServer.mockResolvedValue({ total: 0 });

    const { result } = renderHook(() => useFeedbackRollup(window), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getFeedbackRollupFromServer).toHaveBeenCalledWith(window);
    const [sent] = getFeedbackRollupFromServer.mock.calls[0] as [Record<string, unknown>];
    expect('userId' in sent).toBe(false);
  });

  it('keys the cache on the user so a second account does not inherit the first ones counts', () => {
    expect(feedbackRollupQueryKey('user-1', window.from, window.to)).not.toEqual(
      feedbackRollupQueryKey('user-2', window.from, window.to)
    );
  });

  it('keys the cache on the window so two ranges do not share one result', () => {
    expect(feedbackRollupQueryKey('user-1', window.from, window.to)).not.toEqual(
      feedbackRollupQueryKey('user-1', '2026-01-01T00:00:00.000Z', window.to)
    );
  });

  it('does not fire before the user is hydrated, rather than reading unscoped', () => {
    mocks.currentUser = null;

    renderHook(() => useFeedbackRollup(window), { wrapper });

    expect(getFeedbackRollupFromServer).not.toHaveBeenCalled();
  });

  it('does not fire with a missing bound, rather than asking for an unbounded read', () => {
    renderHook(() => useFeedbackRollup({ from: window.from, to: undefined }), { wrapper });

    expect(getFeedbackRollupFromServer).not.toHaveBeenCalled();
  });
});
