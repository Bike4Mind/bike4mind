import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ISessionDocument } from '@bike4mind/common';

// Mutable mock store shared across the vi.mock factories below.
const h = vi.hoisted(() => {
  type Cb = (state: Record<string, unknown>, prev: Record<string, unknown>) => void;
  const subs = new Set<Cb>();
  const store = {
    state: { programmaticSubmit: null as string | null, programmaticLaunch: null as Record<string, unknown> | null },
    isFresh: true,
  };
  const notify = (prev: Record<string, unknown>) => subs.forEach(cb => cb(store.state, prev));
  const setProgrammaticSubmit = (v: string | null) => {
    const prev = { ...store.state };
    store.state = { ...store.state, programmaticSubmit: v };
    notify(prev);
  };
  const setProgrammaticLaunch = (v: Record<string, unknown> | null) => {
    const prev = { ...store.state };
    store.state = { ...store.state, programmaticLaunch: v };
    notify(prev);
  };
  return {
    store,
    subs,
    getState: () => ({ ...store.state, setProgrammaticSubmit, setProgrammaticLaunch }),
    subscribe: (cb: Cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    setProgrammaticSubmit,
    setProgrammaticLaunch,
  };
});

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { UNINSTANTIATED: -1, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
}));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: { getState: h.getState, subscribe: h.subscribe },
}));
vi.mock('@client/app/utils/briefcase/dispatchDedup', () => ({
  isFreshNonce: () => h.store.isFresh,
}));

import { useProgrammaticSubmit } from '../useProgrammaticSubmit';
import { ReadyState } from '@client/app/contexts/WebsocketContext';

const SESSION = { id: 's1' } as unknown as ISessionDocument;

type Props = {
  handleSendClick: ReturnType<typeof vi.fn>;
  readyState: ReadyState;
  submitting: boolean;
  currentSession: ISessionDocument | null;
};

const baseProps = (over: Partial<Props> = {}): Props => ({
  handleSendClick: vi.fn().mockResolvedValue(undefined),
  readyState: ReadyState.OPEN,
  submitting: false,
  currentSession: SESSION,
  ...over,
});

const renderSubmit = (props: Props) => renderHook((p: Props) => useProgrammaticSubmit(p), { initialProps: props });

beforeEach(() => {
  vi.useFakeTimers();
  h.subs.clear();
  h.store.state = { programmaticSubmit: null, programmaticLaunch: null };
  h.store.isFresh = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useProgrammaticSubmit › programmaticSubmit', () => {
  it('sends a pending prompt once ready with a session, after the 150ms settle', () => {
    h.store.state.programmaticSubmit = 'hello';
    const props = baseProps();

    renderSubmit(props);
    expect(props.handleSendClick).not.toHaveBeenCalled(); // still inside settle delay

    act(() => void vi.advanceTimersByTime(150));
    expect(props.handleSendClick).toHaveBeenCalledTimes(1);
    expect(props.handleSendClick).toHaveBeenCalledWith('hello');
    // The prompt is cleared so it cannot fire twice.
    expect(h.store.state.programmaticSubmit).toBeNull();
  });

  it('/opti guard: does NOT send while currentSession is null, then sends once it arrives', () => {
    h.store.state.programmaticSubmit = 'hello';
    const props = baseProps({ currentSession: null });

    const { rerender } = renderSubmit(props);
    act(() => void vi.advanceTimersByTime(150));
    // Null session must not leak a sessionId:undefined send (would mint a new session).
    expect(props.handleSendClick).not.toHaveBeenCalled();
    expect(h.store.state.programmaticSubmit).toBe('hello');

    // changeSession resolves -> currentSession becomes non-null -> retry effect fires.
    rerender(baseProps({ handleSendClick: props.handleSendClick, currentSession: SESSION }));
    act(() => void vi.advanceTimersByTime(150));
    expect(props.handleSendClick).toHaveBeenCalledTimes(1);
    expect(props.handleSendClick).toHaveBeenCalledWith('hello');
  });

  it('does not send when the websocket is not OPEN', () => {
    h.store.state.programmaticSubmit = 'hello';
    const props = baseProps({ readyState: ReadyState.CONNECTING });

    renderSubmit(props);
    act(() => void vi.advanceTimersByTime(150));
    expect(props.handleSendClick).not.toHaveBeenCalled();
  });
});

describe('useProgrammaticSubmit › programmaticLaunch', () => {
  const launch = (over: Record<string, unknown> = {}) => ({
    promptContent: 'go',
    requiredTools: ['web_search'],
    sessionId: 's1',
    dispatchNonce: 'n1',
    ...over,
  });

  it('consumes a fresh, session-matched launch with its tools override', () => {
    h.store.state.programmaticLaunch = launch();
    const props = baseProps();

    renderSubmit(props);
    act(() => void vi.advanceTimersByTime(150));

    expect(props.handleSendClick).toHaveBeenCalledTimes(1);
    expect(props.handleSendClick).toHaveBeenCalledWith('go', { toolsOverride: ['web_search'] });
    expect(h.store.state.programmaticLaunch).toBeNull();
  });

  it('drops a stale-nonce launch without sending', () => {
    h.store.isFresh = false;
    h.store.state.programmaticLaunch = launch();
    const props = baseProps();

    renderSubmit(props);
    act(() => void vi.advanceTimersByTime(150));

    expect(props.handleSendClick).not.toHaveBeenCalled();
    expect(h.store.state.programmaticLaunch).toBeNull(); // cleared even though not sent
  });

  it('ignores a launch addressed to a different session (election miss)', () => {
    h.store.state.programmaticLaunch = launch({ sessionId: 'other-session' });
    const props = baseProps();

    renderSubmit(props);
    act(() => void vi.advanceTimersByTime(150));

    expect(props.handleSendClick).not.toHaveBeenCalled();
    // Not consumed - left for the matching surface.
    expect(h.store.state.programmaticLaunch).not.toBeNull();
  });

  it('clears pending launch timers on unmount so no send fires into a stale session', () => {
    h.store.state.programmaticLaunch = launch();
    const props = baseProps();

    const { unmount } = renderSubmit(props);
    unmount();
    act(() => void vi.advanceTimersByTime(150));

    expect(props.handleSendClick).not.toHaveBeenCalled();
  });
});
