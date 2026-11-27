// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findRestorable,
  readLastSession,
  restoreGate,
  useLastSession,
  writeLastSession,
  type LastSession,
} from './lastSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(id: string, mode: ChatSessionMode = 'chat', archived = false): ChatSessionSummary {
  return {
    id,
    title: id,
    model: 'm',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mode,
    approvalMode: 'ask',
    reasoningEffort: 'default',
    messageCount: 0,
    ...(archived ? { archived } : {}),
  } as ChatSessionSummary;
}

interface Props {
  remembered?: LastSession | null;
  loading: boolean;
  forgetIfGone?: boolean;
  sessions: ChatSessionSummary[];
  activeId: string | null;
  onRestore: (session: ChatSessionSummary | null) => void;
}

describe('useLastSession', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoring: boolean[];

  function Harness(props: Props) {
    const [remembered] = useState(() => (props.remembered === undefined ? readLastSession() : props.remembered));
    restoring.push(useLastSession({ ...props, remembered }));
    return null;
  }

  const render = (props: Props) => act(() => root.render(<Harness {...props} />));
  const remount = () => {
    act(() => root.unmount());
    root = createRoot(container);
  };

  beforeEach(() => {
    restoring = [];
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.localStorage.clear();
  });

  it('restores the conversation that was open before the shell remounted', () => {
    const sessions = [summary('a'), summary('b', 'code')];
    render({ loading: false, sessions, activeId: 'b', onRestore: vi.fn() });
    expect(readLastSession()).toEqual({ id: 'b', mode: 'code' });

    remount();
    restoring = [];
    const onRestore = vi.fn();
    render({ loading: true, sessions: [], activeId: null, onRestore });
    expect(restoring.at(-1)).toBe(true);
    expect(onRestore).not.toHaveBeenCalled();

    render({ loading: false, sessions, activeId: null, onRestore });
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith(sessions[1]);
    expect(restoring.at(-1)).toBe(false);
  });

  it('never remembers a Studio session as the conversation to reopen', () => {
    writeLastSession({ id: 'a', mode: 'chat' });
    render({ loading: false, sessions: [summary('a'), summary('s', 'studio')], activeId: 's', onRestore: vi.fn() });
    expect(readLastSession()).toEqual({ id: 'a', mode: 'chat' });
  });

  it('falls back and clears a remembered conversation that was deleted', () => {
    writeLastSession({ id: 'gone', mode: 'code' });
    const onRestore = vi.fn();
    render({ loading: false, sessions: [summary('a')], activeId: null, onRestore });
    expect(onRestore).toHaveBeenCalledWith(null);
    expect(readLastSession()).toBeNull();
  });

  it('falls back but keeps a remembered conversation whose host has not answered', () => {
    writeLastSession({ id: 'remote', mode: 'code' });
    const onRestore = vi.fn();
    render({ loading: false, forgetIfGone: false, sessions: [summary('a')], activeId: null, onRestore });
    expect(onRestore).toHaveBeenCalledWith(null);
    expect(readLastSession()).toEqual({ id: 'remote', mode: 'code' });
  });

  it('falls back and clears a remembered conversation that was archived', () => {
    writeLastSession({ id: 'old', mode: 'chat' });
    const onRestore = vi.fn();
    render({ loading: false, sessions: [summary('old', 'chat', true), summary('a')], activeId: null, onRestore });
    expect(onRestore).toHaveBeenCalledWith(null);
    expect(readLastSession()).toBeNull();
  });

  it('leaves a fresh install to the default selection', () => {
    const onRestore = vi.fn();
    render({ loading: true, sessions: [], activeId: null, onRestore });
    expect(restoring).toEqual([false]);
    render({ loading: false, sessions: [], activeId: null, onRestore });
    expect(onRestore).not.toHaveBeenCalled();
    expect(readLastSession()).toBeNull();
  });

  it('does not overwrite the remembered value before it has been restored', () => {
    writeLastSession({ id: 'b', mode: 'code' });
    render({ loading: true, sessions: [summary('a')], activeId: 'a', onRestore: vi.fn() });
    expect(readLastSession()).toEqual({ id: 'b', mode: 'code' });
  });
});

describe('readLastSession', () => {
  afterEach(() => window.localStorage.clear());

  it('ignores a value it cannot use', () => {
    window.localStorage.setItem('b4m.chat.lastSession', '{"id":"a","mode":"other"}');
    expect(readLastSession()).toBeNull();
    window.localStorage.setItem('b4m.chat.lastSession', 'not json');
    expect(readLastSession()).toBeNull();
  });
});

describe('findRestorable', () => {
  it('finds the remembered id among the loaded summaries', () => {
    const sessions = [summary('a'), summary('b')];
    expect(findRestorable({ id: 'b', mode: 'chat' }, sessions)).toBe(sessions[1]);
    expect(findRestorable(null, sessions)).toBeNull();
  });
});

describe('restoreGate', () => {
  const gate = (input: Partial<Parameters<typeof restoreGate>[0]>) =>
    restoreGate({
      rememberedHost: 'local',
      listing: undefined,
      hostsListed: true,
      localLoading: false,
      listed: false,
      ...input,
    });

  it('waits for a local session only on the local listing, never on a remote one', () => {
    expect(gate({ localLoading: true })).toEqual({ wait: true, forgetIfGone: true });
    expect(gate({ listing: 'loading' })).toEqual({ wait: false, forgetIfGone: true });
  });

  it('waits for a remote session until its host lists, even while it is still connecting', () => {
    expect(gate({ rememberedHost: 'devbox', listing: 'loading' }).wait).toBe(true);
    expect(gate({ rememberedHost: 'devbox', listing: 'pending' }).wait).toBe(true);
    expect(gate({ rememberedHost: 'devbox', listing: undefined, hostsListed: false }).wait).toBe(true);
    expect(gate({ rememberedHost: 'devbox', listing: 'pending', listed: true }).wait).toBe(false);
    expect(gate({ rememberedHost: 'devbox', listing: 'live' })).toEqual({ wait: false, forgetIfGone: true });
  });

  it('keeps a remote session it could not find while its host has not answered', () => {
    expect(gate({ rememberedHost: 'devbox', listing: 'stale' })).toEqual({ wait: false, forgetIfGone: false });
    expect(gate({ rememberedHost: 'devbox', listing: undefined, hostsListed: true })).toEqual({
      wait: false,
      forgetIfGone: true,
    });
  });
});
