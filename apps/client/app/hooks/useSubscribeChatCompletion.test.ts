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
const { subscribeToAction, artifactPersistence } = vi.hoisted(() => ({
  subscribeToAction: vi.fn((_action: string, _cb: unknown) => () => {}),
  // Stable object: the hook lists it as an effect dependency.
  artifactPersistence: { persistArtifactsFromQuest: vi.fn(), reset: vi.fn() },
}));

vi.mock('./useStreamingArtifactPersistence', () => ({
  useStreamingArtifactPersistence: () => artifactPersistence,
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction }),
}));

import { useSubscribeChatCompletion } from './useSubscribeChatCompletion';
import useSessionLayout from './useSessionLayout';
import { blankRapidReplies } from './chatCompletionState';

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

  it('resets when leaving a real session for a new notebook (null id)', () => {
    const { result, rerender } = mount('session-a');

    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Running...' }));
    });

    rerender({ sessionId: null });
    expect(result.current.chatCompletion.completed).toBe(true);
    expect(result.current.chatCompletion.statusMessage).toBeUndefined();
  });

  it("keeps the tab's own send through the new-notebook flow (null -> optimistic -> real)", () => {
    const { result, rerender } = mount(null);

    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Generating' }));
    });

    rerender({ sessionId: 'optimistic-session-xyz' });
    rerender({ sessionId: 'session-new' });
    expect(result.current.chatCompletion.completed).toBe(false);
  });
});

type StreamHandler = (msg: unknown) => Promise<void>;

const latestStreamHandler = (): StreamHandler => {
  const calls = subscribeToAction.mock.calls.filter(([action]) => action === 'streamed_chat_completion');
  return calls[calls.length - 1][1] as StreamHandler;
};

const frame = (id: string, sessionId: string, status: 'running' | 'done' | 'stopped', statusMessage?: string) => ({
  action: 'streamed_chat_completion',
  statusMessage,
  quest: { id, sessionId, type: 'message', status, replies: ['partial'] },
});

describe('useSubscribeChatCompletion - stuck Stop regressions', () => {
  beforeEach(() => {
    subscribeToAction.mockClear();
  });

  it("does not adopt another session's stream on a new notebook the user has not sent from", async () => {
    const { result } = mount(null);

    await act(async () => {
      await latestStreamHandler()(frame('foreign-q', 'foreign-session', 'running', 'Running...'));
    });

    expect(result.current.chatCompletion.completed).toBe(true);
    expect(result.current.chatCompletion.quest).toBeUndefined();
  });

  it("treats a 'stopped' frame as terminal", async () => {
    const { result } = mount('session-a');

    await act(async () => {
      await latestStreamHandler()(frame('q-stop', 'session-a', 'running'));
    });
    expect(result.current.chatCompletion.completed).toBe(false);

    await act(async () => {
      await latestStreamHandler()(frame('q-stop', 'session-a', 'stopped', 'Generation cancelled by user'));
    });
    expect(result.current.chatCompletion.completed).toBe(true);
  });

  it("ignores a 'running' frame that arrives after the quest's terminal frame", async () => {
    const { result } = mount('session-a');

    await act(async () => {
      await latestStreamHandler()(frame('q-late', 'session-a', 'done'));
    });
    expect(result.current.chatCompletion.completed).toBe(true);

    await act(async () => {
      await latestStreamHandler()(frame('q-late', 'session-a', 'running', 'Running...'));
    });
    expect(result.current.chatCompletion.completed).toBe(true);
  });
});

describe('useSubscribeChatCompletion - first send from /new', () => {
  const OPTIMISTIC_ID = 'optimistic-session-first';

  beforeEach(() => {
    subscribeToAction.mockClear();
    useSessionLayout.setState({ pendingOptimisticId: null, pendingRealSessionId: null });
  });

  const stream = async (msg: unknown) => {
    await act(async () => {
      await latestStreamHandler()(msg);
    });
  };

  it('tracks the own quest when its first frame lands before the real id (placeholder kept)', async () => {
    const { result, rerender } = mount(null);
    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Generating' }));
    });
    useSessionLayout.setState({ pendingOptimisticId: OPTIMISTIC_ID });
    rerender({ sessionId: OPTIMISTIC_ID });
    // session.created for this tab's send, recorded before the view leaves the optimistic id.
    useSessionLayout.setState({ pendingRealSessionId: 'real-1' });

    await stream(frame('own-q1', 'real-1', 'running', 'Running...'));
    expect(result.current.chatCompletion.quest?.id).toBe('own-q1');
    expect(result.current.chatCompletion.completed).toBe(false);

    useSessionLayout.setState({ pendingOptimisticId: null });
    rerender({ sessionId: 'real-1' });
    await stream(frame('own-q1', 'real-1', 'running'));
    expect(result.current.chatCompletion.completed).toBe(false);

    await stream(frame('own-q1', 'real-1', 'done'));
    expect(result.current.chatCompletion.completed).toBe(true);
  });

  it('tracks the own quest when its first frame lands after the real id', async () => {
    const { result, rerender } = mount(null);
    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Generating' }));
    });
    rerender({ sessionId: OPTIMISTIC_ID });
    rerender({ sessionId: 'real-2' });
    expect(result.current.chatCompletion.completed).toBe(false);

    await stream(frame('own-q2', 'real-2', 'running', 'Running...'));
    expect(result.current.chatCompletion.quest?.id).toBe('own-q2');
    expect(result.current.chatCompletion.completed).toBe(false);
  });

  it('adopts the own first frame after the /new -> notebook remount wiped the placeholder', async () => {
    // Fresh provider mounted straight on the optimistic URL, as the route swap does.
    useSessionLayout.setState({ pendingOptimisticId: OPTIMISTIC_ID, pendingRealSessionId: 'real-3' });
    const { result } = mount(OPTIMISTIC_ID);
    expect(result.current.chatCompletion.completed).toBe(true);

    await stream(frame('own-q3', 'real-3', 'running', 'Running...'));
    expect(result.current.chatCompletion.quest?.id).toBe('own-q3');
    expect(result.current.chatCompletion.completed).toBe(false);

    // A second session's stream in the same window is still refused.
    await stream(frame('foreign-q', 'foreign-session', 'running', 'Foreign'));
    expect(result.current.chatCompletion.quest?.id).toBe('own-q3');
  });

  it('refuses a foreign stream on an optimistic id this tab is not minting', async () => {
    useSessionLayout.setState({ pendingOptimisticId: 'optimistic-session-someone-else' });
    const { result } = mount(OPTIMISTIC_ID);

    await stream(frame('foreign-q', 'foreign-session', 'running', 'Running...'));
    expect(result.current.chatCompletion.completed).toBe(true);
    expect(result.current.chatCompletion.quest).toBeUndefined();
  });
});

describe('useSubscribeChatCompletion - another tab streaming during a /new send', () => {
  const OPTIMISTIC_ID = 'optimistic-session-tab-b';
  const foreign = (status: 'running' | 'done' = 'running') => ({
    ...frame('tab-a-q', 'tab-a-session', status, 'Tab A status'),
    quest: { id: 'tab-a-q', sessionId: 'tab-a-session', type: 'message', status, replies: ['tab A reply'] },
  });

  beforeEach(() => {
    subscribeToAction.mockClear();
    useSessionLayout.setState({ pendingOptimisticId: null, pendingRealSessionId: null });
  });

  const stream = async (msg: unknown) => {
    await act(async () => {
      await latestStreamHandler()(msg);
    });
  };

  it('refuses the foreign stream before the real session is known, then adopts only its own', async () => {
    useSessionLayout.setState({ pendingOptimisticId: OPTIMISTIC_ID });
    const { result } = mount(OPTIMISTIC_ID);

    await stream(foreign());
    expect(result.current.chatCompletion.quest).toBeUndefined();
    expect(result.current.chatCompletion.completed).toBe(true);

    useSessionLayout.setState({ pendingRealSessionId: 'tab-b-session' });
    await stream(foreign());
    expect(result.current.chatCompletion.quest).toBeUndefined();

    await stream(frame('tab-b-q', 'tab-b-session', 'running', 'Running...'));
    expect(result.current.chatCompletion.quest?.id).toBe('tab-b-q');
    expect(result.current.chatCompletion.completed).toBe(false);

    await stream(foreign('done'));
    expect(result.current.chatCompletion.quest).toMatchObject({ id: 'tab-b-q', replies: ['partial'] });
    expect(result.current.chatCompletion.statusMessage).toBe('Running...');
    expect(result.current.chatCompletion.completed).toBe(false);

    await stream(frame('tab-b-q', 'tab-b-session', 'done'));
    expect(result.current.chatCompletion.completed).toBe(true);
  });

  it('refuses the foreign stream on the /new provider that has not unmounted yet', async () => {
    const { result } = mount(null);
    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Generating' }));
    });
    useSessionLayout.setState({ pendingOptimisticId: OPTIMISTIC_ID });

    await stream(foreign());
    expect(result.current.chatCompletion.quest).toBeUndefined();
    expect(result.current.chatCompletion.statusMessage).toBe('Generating');
  });

  it('holds a still-null view to a client-created session once it is recorded', async () => {
    const { result } = mount(null);
    act(() => {
      result.current.setChatCompletion(prev => ({ ...prev, completed: false, statusMessage: 'Generating' }));
    });
    useSessionLayout.setState({ pendingRealSessionId: 'lake-session' });

    await stream(foreign());
    expect(result.current.chatCompletion.quest).toBeUndefined();

    await stream(frame('lake-q', 'lake-session', 'running'));
    expect(result.current.chatCompletion.quest?.id).toBe('lake-q');
  });
});

describe('useSubscribeChatCompletion - rapid-reply acks', () => {
  const OPTIMISTIC_ID = 'optimistic-session-rapid';
  const ack = (ids: { sessionId?: string; questId?: string }, content = 'On it') => ({
    action: 'streamed_rapid_reply',
    ...ids,
    rapidReply: { content, status: 'completed', modelId: 'm', mappingId: 'map' },
  });

  beforeEach(() => {
    subscribeToAction.mockClear();
    useSessionLayout.setState({ pendingOptimisticId: null, pendingRealSessionId: null });
    while (blankRapidReplies.claim());
  });

  const stream = async (msg: unknown) => {
    await act(async () => {
      await latestStreamHandler()(msg);
    });
  };

  it("refuses another session's ack on a real view and accepts the view's own", async () => {
    const { result } = mount('s1');

    await stream(ack({ sessionId: 'tab-a-session' }, 'Tab A ack'));
    expect(result.current.chatCompletion.rapidReply).toBeUndefined();

    await stream(ack({ sessionId: 's1' }));
    expect(result.current.chatCompletion.rapidReply?.content).toBe('On it');
  });

  it("refuses another session's ack on the optimistic view before and after the real id is recorded", async () => {
    useSessionLayout.setState({ pendingOptimisticId: OPTIMISTIC_ID });
    const { result } = mount(OPTIMISTIC_ID);

    await stream(ack({ sessionId: 'tab-a-session' }, 'Tab A ack'));
    expect(result.current.chatCompletion.rapidReply).toBeUndefined();

    useSessionLayout.setState({ pendingRealSessionId: 'tab-b-session' });
    await stream(ack({ sessionId: 'tab-a-session' }, 'Tab A ack'));
    expect(result.current.chatCompletion.rapidReply).toBeUndefined();

    await stream(ack({ sessionId: 'tab-b-session' }));
    expect(result.current.chatCompletion.rapidReply?.content).toBe('On it');
  });

  it('accepts the own id-less /new ack once, whether it lands before or after session.created', async () => {
    useSessionLayout.setState({ pendingOptimisticId: OPTIMISTIC_ID });
    const { result, rerender } = mount(OPTIMISTIC_ID);

    // Another tab's id-less ack with no request of ours in flight.
    await stream(ack({}, 'Tab C ack'));
    expect(result.current.chatCompletion.rapidReply).toBeUndefined();

    const release = blankRapidReplies.begin();
    useSessionLayout.setState({ pendingOptimisticId: null, pendingRealSessionId: null });
    rerender({ sessionId: 'tab-b-session' });
    await stream(ack({}));
    expect(result.current.chatCompletion.rapidReply?.content).toBe('On it');

    // Claimed: a second id-less ack is not ours.
    await stream(ack({}, 'Tab C ack'));
    expect(result.current.chatCompletion.rapidReply?.content).toBe('On it');
    release();
  });

  it('accepts a quest-only ack just for the held quest', async () => {
    const { result } = mount(null);
    act(() => {
      result.current.setChatCompletion(prev => ({
        ...prev,
        completed: false,
        quest: { id: 'own-q', sessionId: 'real', type: 'message', status: 'running' },
      }));
    });

    await stream(ack({ questId: 'foreign-q' }, 'Foreign'));
    expect(result.current.chatCompletion.rapidReply).toBeUndefined();

    await stream(ack({ questId: 'own-q' }));
    expect(result.current.chatCompletion.rapidReply?.content).toBe('On it');
  });
});

describe('useSubscribeChatCompletion - artifact persistence', () => {
  beforeEach(() => {
    subscribeToAction.mockClear();
    artifactPersistence.persistArtifactsFromQuest.mockClear();
  });

  it("persists artifacts for a 'done' quest", async () => {
    mount('session-art');
    await act(async () => {
      await latestStreamHandler()(frame('art-done', 'session-art', 'done'));
    });
    expect(artifactPersistence.persistArtifactsFromQuest).toHaveBeenCalledTimes(1);
  });

  it("does not persist a stopped quest's partial reply", async () => {
    mount('session-art');
    await act(async () => {
      await latestStreamHandler()(frame('art-stopped', 'session-art', 'stopped'));
    });
    expect(artifactPersistence.persistArtifactsFromQuest).not.toHaveBeenCalled();
  });
});
