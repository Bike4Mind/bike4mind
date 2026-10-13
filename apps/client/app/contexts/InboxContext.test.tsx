// @vitest-environment jsdom
import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxProvider } from './InboxContext';

type Callback = (type: string, data: unknown) => void;

const mocks = vi.hoisted(() => {
  const invalidateQueries = vi.fn();
  return {
    invalidateQueries,
    // Stable across renders like the real QueryClient; a fresh object per call would rebuild the debounce.
    queryClient: { invalidateQueries },
    callbacks: {} as Record<string, Callback>,
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
}));
vi.mock('../components/inbox/Modal', () => ({ default: () => null }));
vi.mock('./UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) => selector({ currentUser: { id: 'user-1' } }),
}));
vi.mock('../utils/react-query', () => ({
  updateAllQueryData: vi.fn(),
  useSubscribeCollection: (collection: string, _query: unknown, callback: Callback) => {
    mocks.callbacks[collection] = callback;
  },
}));

const fireInviteBurst = (count: number) => {
  act(() => {
    for (let i = 0; i < count; i++) {
      mocks.callbacks.invites(i % 3 === 0 ? 'delete' : 'insert', { id: `invite-${i}` });
    }
  });
};

describe('InboxProvider invites subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invalidateQueries.mockReset();
    mocks.callbacks = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches the inbox invites once per burst of events, not once per event', () => {
    render(<InboxProvider>{null}</InboxProvider>);

    fireInviteBurst(25);
    act(() => {
      vi.runAllTimers();
    });

    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['invites', 'inbox'] });

    fireInviteBurst(1);
    act(() => {
      vi.runAllTimers();
    });

    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('keeps one debounce across re-renders, so a burst split by a re-render still gives one refetch', () => {
    const { rerender } = render(<InboxProvider>{null}</InboxProvider>);
    const firstCallback = mocks.callbacks.invites;

    act(() => {
      for (let i = 0; i < 12; i++) firstCallback('insert', { id: `invite-${i}` });
    });
    rerender(<InboxProvider>{null}</InboxProvider>);
    const latestCallback = mocks.callbacks.invites;
    act(() => {
      for (let i = 12; i < 25; i++) latestCallback('insert', { id: `invite-${i}` });
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(latestCallback).toBe(firstCallback);
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('refetches while events are still arriving rather than waiting for the stream to go quiet', () => {
    render(<InboxProvider>{null}</InboxProvider>);

    // One event every 200 ms never lets the 250 ms trailing edge fire; only maxWait can.
    for (let elapsed = 0; elapsed < 1500; elapsed += 200) {
      act(() => {
        mocks.callbacks.invites('insert', { id: `invite-${elapsed}` });
        vi.advanceTimersByTime(200);
      });
    }

    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('drops a pending refetch on unmount', () => {
    const { unmount } = render(<InboxProvider>{null}</InboxProvider>);

    fireInviteBurst(3);
    unmount();
    act(() => {
      vi.runAllTimers();
    });

    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });
});
