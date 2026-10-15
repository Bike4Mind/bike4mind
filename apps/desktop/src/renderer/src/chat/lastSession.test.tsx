// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRestorable, readLastSession, useLastSession, writeLastSession, type LastSession } from './lastSession';

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

  it('falls back and clears a remembered conversation that was deleted', () => {
    writeLastSession({ id: 'gone', mode: 'code' });
    const onRestore = vi.fn();
    render({ loading: false, sessions: [summary('a')], activeId: null, onRestore });
    expect(onRestore).toHaveBeenCalledWith(null);
    expect(readLastSession()).toBeNull();
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
