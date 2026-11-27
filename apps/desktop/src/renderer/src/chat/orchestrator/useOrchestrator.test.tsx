// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatStreamEvent } from '@shared/chat';
import type { HostBridgeApi } from '@shared/hostBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivity } from './activity';
import { writeView } from './orchestratorPrefs';
import { singlePaneLayout } from './orchestratorLayout';
import { useAgentActivity, useOrchestratorPrefs, useOrchestratorRoster } from './useOrchestrator';
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let listener: ((event: ChatStreamEvent) => void) | null;
let bridge: HostBridgeApi;
// Events go through the test bridge, which delivers them as session/event to subscribed sessions.
const onStreamEvent = (fn: (event: ChatStreamEvent) => void) => {
  listener = fn;
  return () => undefined;
};

beforeEach(() => {
  listener = null;
  window.localStorage.clear();
  bridge = chatBackedHostBridge();
  vi.spyOn(bridge, 'request');
  (window as unknown as { b4m: unknown }).b4m = { host: bridge, chat: { onStreamEvent } };
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

const emit = (event: ChatStreamEvent) => act(async () => listener?.(event));
const subscribeCalls = () =>
  vi.mocked(bridge.request).mock.calls.filter(([, method]) => method === 'session/subscribe');
const unsubscribeCalls = () =>
  vi.mocked(bridge.request).mock.calls.filter(([, method]) => method === 'session/unsubscribe');

describe('useAgentActivity', () => {
  it('subscribes once per tracked session, folds tool-start, and unsubscribes on unmount', async () => {
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const Probe = () => {
      latest = useAgentActivity(new Set(['s1']));
      return null;
    };
    await act(async () => root.render(<Probe />));
    expect(subscribeCalls().map(([, , params]) => params)).toEqual([{ sessionId: 's1' }]);
    expect(latest.size).toBe(0);

    await emit(toolStart('s1'));
    expect(latest.get('s1')).toEqual({ kind: 'tool', tool: 'read_file', detail: 'file.ts' });

    await act(async () => root.unmount());
    expect(unsubscribeCalls().map(([, , params]) => params)).toEqual([{ sessionId: 's1' }]);
    root = createRoot(container);
  });
});

describe('useAgentActivity filtering', () => {
  it('never re-renders for a session outside the tracked set', async () => {
    let renders = 0;
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const tracked = new Set(['mine']);
    const Probe = () => {
      renders += 1;
      latest = useAgentActivity(tracked);
      return null;
    };
    await act(async () => root.render(<Probe />));
    const settled = renders;

    await emit(toolStart('elsewhere'));
    expect(renders).toBe(settled);
    expect(latest.size).toBe(0);

    await emit(toolStart('mine'));
    expect(latest.has('mine')).toBe(true);
  });
});

describe('useAgentActivity for a just-spawned child', () => {
  // Only tracked sessions are subscribed, so what a child streamed before it joined the roster is
  // not replayed; its activity starts from its next event.
  it('shows a child from its first event after it is tracked', async () => {
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const Probe = ({ tracked }: { tracked: ReadonlySet<string> }) => {
      latest = useAgentActivity(tracked);
      return null;
    };
    await act(async () => root.render(<Probe tracked={new Set(['parent'])} />));
    await emit(toolStart('child'));
    await act(async () => root.render(<Probe tracked={new Set(['parent', 'child'])} />));
    expect(latest.has('child')).toBe(false);

    await emit(toolStart('child'));
    expect(latest.get('child')).toEqual({ kind: 'tool', tool: 'read_file', detail: 'file.ts' });
  });
});

describe('useAgentActivity and a re-listed roster', () => {
  it('does not resubscribe when the tracked set is rebuilt with the same ids', async () => {
    const Probe = ({ tracked }: { tracked: ReadonlySet<string> }) => {
      useAgentActivity(tracked);
      return null;
    };
    await act(async () => root.render(<Probe tracked={new Set(['a', 'b'])} />));
    await act(async () => root.render(<Probe tracked={new Set(['b', 'a'])} />));
    expect(subscribeCalls()).toHaveLength(2);
    expect(unsubscribeCalls()).toHaveLength(0);
  });
});

describe('useAgentActivity pruning', () => {
  it('drops activity for an id that is no longer tracked, and its subscription', async () => {
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const Probe = ({ tracked }: { tracked: ReadonlySet<string> }) => {
      latest = useAgentActivity(tracked);
      return null;
    };
    await act(async () => root.render(<Probe tracked={new Set(['a', 'b'])} />));
    await emit(toolStart('a'));
    await emit(toolStart('b'));
    await act(async () => root.render(<Probe tracked={new Set(['b'])} />));
    expect([...latest.keys()]).toEqual(['b']);
    expect(unsubscribeCalls().map(([, , params]) => params)).toEqual([{ sessionId: 'a' }]);
  });
});

describe('useOrchestratorRoster', () => {
  it('is empty without a root', () => {
    let latest: ReturnType<typeof useOrchestratorRoster> | undefined;
    const Probe = () => {
      latest = useOrchestratorRoster(null, [], new Map(), new Map());
      return null;
    };
    act(() => root.render(<Probe />));
    expect(latest).toEqual({ agents: [], parent: {} });
  });

  it("tracks the root's own activity and status as the parent, apart from the agents", async () => {
    let latest: ReturnType<typeof useOrchestratorRoster> | undefined;
    const statuses = new Map([['root', 'processing' as const]]);
    const Probe = () => {
      latest = useOrchestratorRoster('root', [], statuses, new Map());
      return null;
    };
    await act(async () => root.render(<Probe />));
    await emit(toolStart('root'));
    expect(latest?.agents).toEqual([]);
    expect(latest?.parent).toEqual({
      status: 'processing',
      activity: { kind: 'tool', tool: 'read_file', detail: 'file.ts' },
    });
  });
});

describe('useOrchestratorPrefs', () => {
  it("starts a new session on its project's last view, and records picks for the project", () => {
    writeView('a', 'aquarium', '/p');
    writeView('x', 'table', '/other');
    let latest: ReturnType<typeof useOrchestratorPrefs> | undefined;
    const Probe = ({ id, project }: { id: string; project?: string }) => {
      latest = useOrchestratorPrefs(id, project);
      return null;
    };
    act(() => root.render(<Probe id="b" project="/p" />));
    expect(latest?.view).toBe('aquarium');
    act(() => latest?.setLayout(singlePaneLayout('board')));
    expect(window.localStorage.getItem('b4m.orchestrator.projectView./p')).toBe('board');
    act(() => root.render(<Probe id="b" project="/q" />));
    expect(latest?.view).toBe('board');
  });

  it('re-reads when only the project changes, and writes to the current project', () => {
    window.localStorage.setItem('b4m.orchestrator.projectView./q', 'table');
    let latest: ReturnType<typeof useOrchestratorPrefs> | undefined;
    const Probe = ({ project }: { project?: string }) => {
      latest = useOrchestratorPrefs('s', project);
      return null;
    };
    act(() => root.render(<Probe />));
    expect(latest?.view).toBe('tavern');
    act(() => root.render(<Probe project="/q" />));
    expect(latest?.view).toBe('table');
    act(() => latest?.setLayout(singlePaneLayout('board')));
    expect(window.localStorage.getItem('b4m.orchestrator.projectView./q')).toBe('board');
    expect(window.localStorage.getItem('b4m.orchestrator.projectView./p')).toBeNull();
  });

  it('keeps a session with no id on the tavern and writes nothing', () => {
    let latest: ReturnType<typeof useOrchestratorPrefs> | undefined;
    const Probe = () => {
      latest = useOrchestratorPrefs(null, '/p');
      return null;
    };
    act(() => root.render(<Probe />));
    act(() => latest?.setLayout(singlePaneLayout('board')));
    expect(latest?.view).toBe('tavern');
    expect(window.localStorage.length).toBe(0);
  });

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
    expect(latest?.view).toBe('board');

    act(() => latest?.setLayout(singlePaneLayout('table')));
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
