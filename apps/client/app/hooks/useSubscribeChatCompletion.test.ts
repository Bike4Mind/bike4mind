import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

/**
 * Regression coverage for the forked-session composer Stop-lock: switching to a
 * different real session while a completion is in-flight left the previous
 * session's `completed: false` state in place, so the newly-viewed session's
 * composer showed a spurious "Stop Generation" button until the OTHER
 * session's stream ended.
 */
const { subscribeToAction } = vi.hoisted(() => ({
  subscribeToAction: vi.fn((_action: string, _cb: unknown) => () => {}),
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction }),
}));

import { useSubscribeChatCompletion } from './useSubscribeChatCompletion';

const mount = (sessionId: string | null) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(({ sessionId }: { sessionId: string | null }) => useSubscribeChatCompletion(sessionId), {
    initialProps: { sessionId },
    wrapper,
  });
};

describe('useSubscribeChatCompletion - reset on session switch', () => {
  beforeEach(() => {
    subscribeToAction.mockClear();
  });

  it('resets a stale in-flight chatCompletion when switching between two real sessions', () => {
    const { result, rerender } = mount('session-a');

    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Running...' }));
    });
    expect(result.current.chatCompletion.completed).toBe(false);

    rerender({ sessionId: 'session-b' });

    expect(result.current.chatCompletion.completed).toBe(true);
    expect(result.current.chatCompletion.statusMessage).toBeUndefined();
  });

  it('does not reset when the sessionId only transitions through an optimistic id for the same session', () => {
    const { result, rerender } = mount('session-a');

    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Running...' }));
    });

    rerender({ sessionId: 'optimistic-session-xyz' });
    expect(result.current.chatCompletion.completed).toBe(false);

    rerender({ sessionId: 'session-a' });
    expect(result.current.chatCompletion.completed).toBe(false);
  });

  it('resets when a different real session resolves after passing through a null id', () => {
    const { result, rerender } = mount('session-a');

    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Running...' }));
    });

    rerender({ sessionId: null });
    expect(result.current.chatCompletion.completed).toBe(false);

    rerender({ sessionId: 'session-b' });
    expect(result.current.chatCompletion.completed).toBe(true);
  });
});
