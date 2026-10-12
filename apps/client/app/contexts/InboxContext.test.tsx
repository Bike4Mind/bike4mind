// @vitest-environment jsdom
import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxProvider } from './InboxContext';

type Callback = (type: string, data: unknown) => void;

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  callbacks: {} as Record<string, Callback>,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
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
