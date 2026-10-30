// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivity } from './activity';
import { writeView } from './orchestratorPrefs';
import { useAgentActivity, useOrchestratorPrefs, useOrchestratorRoster } from './useOrchestrator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let listener: ((event: ChatStreamEvent) => void) | null;
const unsubscribe = vi.fn();
const onStreamEvent = vi.fn((fn: (event: ChatStreamEvent) => void) => {
  listener = fn;
  return unsubscribe;
});

beforeEach(() => {
  listener = null;
  unsubscribe.mockClear();
  onStreamEvent.mockClear();
  window.localStorage.clear();
  (window as unknown as { b4m: unknown }).b4m = { chat: { onStreamEvent } };
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function toolStart(sessionId: string): ChatStreamEvent {
  return {
    type: 'tool-start',
    sessionId,
    call: { id: 'c1', name: 'read_file', input: { path: '/a/b/file.ts' } },
  } as unknown as ChatStreamEvent;
}

describe('useAgentActivity', () => {
  it('subscribes once, folds tool-start, and unsubscribes on unmount', () => {
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const Probe = () => {
      latest = useAgentActivity(new Set(['s1']));
      return null;
    };
    act(() => root.render(<Probe />));
    expect(onStreamEvent).toHaveBeenCalledTimes(1);
    expect(latest.size).toBe(0);

    act(() => listener?.(toolStart('s1')));
    expect(latest.get('s1')).toEqual({ kind: 'tool', tool: 'read_file', detail: 'file.ts' });

    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});

describe('useAgentActivity filtering', () => {
  it('never re-renders for a session outside the tracked set', () => {
    let renders = 0;
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const tracked = new Set(['mine']);
    const Probe = () => {
      renders += 1;
      latest = useAgentActivity(tracked);
      return null;
    };
    act(() => root.render(<Probe />));
    const settled = renders;

    act(() => listener?.(toolStart('elsewhere')));
    expect(renders).toBe(settled);
    expect(latest.size).toBe(0);

    act(() => listener?.(toolStart('mine')));
    expect(latest.has('mine')).toBe(true);
  });
});

describe('useOrchestratorRoster', () => {
  it('is empty without a root', () => {
    let latest: unknown[] = [1];
    const Probe = () => {
      latest = useOrchestratorRoster(null, [], new Map(), new Map());
      return null;
    };
    act(() => root.render(<Probe />));
    expect(latest).toEqual([]);
  });
});

describe('useOrchestratorPrefs', () => {
  it('re-reads when the session changes and setters write through immediately', () => {
    writeView('a', 'board');
    let latest: ReturnType<typeof useOrchestratorPrefs> | undefined;
    const Probe = ({ id }: { id: string | null }) => {
      latest = useOrchestratorPrefs(id);
      return null;
    };
    act(() => root.render(<Probe id="a" />));
    expect(latest?.view).toBe('board');
    expect(latest?.surface).toBe('chat');

    act(() => root.render(<Probe id="b" />));
    expect(latest?.view).toBe('tavern');

    act(() => latest?.setView('table'));
    expect(latest?.view).toBe('table');
    expect(window.localStorage.getItem('b4m.orchestrator.view.b')).toBe('table');

    act(() => latest?.setSurface('orchestrate'));
    expect(latest?.surface).toBe('orchestrate');
    expect(window.localStorage.getItem('b4m.orchestrator.surface.b')).toBe('orchestrate');

    act(() => latest?.setDockOpen(false));
    expect(latest?.dockOpen).toBe(false);

    act(() => root.render(<Probe id="a" />));
    expect(latest?.view).toBe('board');
    expect(latest?.surface).toBe('chat');
  });
});
