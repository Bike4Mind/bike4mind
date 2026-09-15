import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';
import { feedbackSessionQueryKey, useGetFeedbackBySessionId } from './feedback';

/**
 * Direct coverage of the hook backing the in-thread "Reported" annotation - every consumer test
 * (MessageContent.gating.test.tsx, .rapidReplyOrder.test.tsx) mocks this module away, so the
 * request shape and the optimistic-id guard had no test of their own before this file.
 */

const getFeedbackFromServer = vi.fn();
vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackFromServer: (...args: unknown[]) => getFeedbackFromServer(...args),
}));

const mocks = vi.hoisted(() => ({ currentUser: null as { id: string } | null }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mocks.currentUser }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: new QueryClient() }, children);

beforeEach(() => {
  getFeedbackFromServer.mockReset();
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
