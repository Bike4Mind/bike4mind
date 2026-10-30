// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
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

describe('useAgentActivity for a just-spawned child', () => {
  it('applies activity that streamed before the child became tracked', () => {
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const Probe = ({ tracked }: { tracked: ReadonlySet<string> }) => {
      latest = useAgentActivity(tracked);
      return null;
    };
    act(() => root.render(<Probe tracked={new Set(['parent'])} />));
    act(() => listener?.(toolStart('child')));
    expect(latest.has('child')).toBe(false);

    act(() => root.render(<Probe tracked={new Set(['parent', 'child'])} />));
    expect(latest.get('child')).toEqual({ kind: 'tool', tool: 'read_file', detail: 'file.ts' });
  });

  // Fires an event from a layout effect: after the render that tracks the id (so the listener already
  // sees it tracked) but before the passive effect that adopts its buffered activity.
  function InGap({ event }: { event?: ChatStreamEvent }) {
    useLayoutEffect(() => {
      if (event) listener?.(event);
    }, [event]);
    return null;
  }

  function gapProbe() {
    const seen: { latest: ReadonlyMap<string, AgentActivity> } = { latest: new Map() };
    const Probe = ({ tracked, gapEvent }: { tracked: ReadonlySet<string>; gapEvent?: ChatStreamEvent }) => {
      seen.latest = useAgentActivity(tracked);
      return <InGap event={gapEvent} />;
    };
    return { seen, Probe };
  }

  it('keeps the buffered activity when an event it does not fold lands before adoption', () => {
    const { seen, Probe } = gapProbe();
    act(() => root.render(<Probe tracked={new Set<string>()} />));
    act(() => listener?.(toolStart('child')));
    const unfolded = { type: 'background-output', sessionId: 'child', processId: 'p', text: 'x' } as never;
    act(() => root.render(<Probe tracked={new Set(['child'])} gapEvent={unfolded} />));
    expect(seen.latest.get('child')).toEqual({ kind: 'tool', tool: 'read_file', detail: 'file.ts' });
  });

  it('lets a live phase landing before adoption replace the buffered activity', () => {
    const { seen, Probe } = gapProbe();
    act(() => root.render(<Probe tracked={new Set<string>()} />));
    act(() => listener?.(toolStart('child')));
    const thinking: ChatStreamEvent = {
      type: 'phase',
      sessionId: 'child',
      messageId: 'm',
      phase: { kind: 'thinking' },
    };
    act(() => root.render(<Probe tracked={new Set(['child'])} gapEvent={thinking} />));
    expect(seen.latest.get('child')).toEqual({ kind: 'phase', phase: 'thinking' });
  });

  it('never resurrects buffered activity for a turn that ended before adoption', () => {
    const { seen, Probe } = gapProbe();
    act(() => root.render(<Probe tracked={new Set<string>()} />));
    act(() => listener?.(toolStart('child')));
    const done = { type: 'done', sessionId: 'child', messageId: 'm', content: '' } as ChatStreamEvent;
    act(() => root.render(<Probe tracked={new Set(['child'])} gapEvent={done} />));
    expect(seen.latest.has('child')).toBe(false);
  });
});

describe('useAgentActivity and a re-listed roster', () => {
  it('does not reconcile again when the tracked set is rebuilt with the same ids', () => {
    // Every session-list change rebuilds the set; `has` calls are the reconcile pass doing its work.
    class CountingSet extends Set<string> {
      lookups = 0;
      override has(value: string) {
        this.lookups += 1;
        return super.has(value);
      }
    }
    const Probe = ({ tracked }: { tracked: ReadonlySet<string> }) => {
      useAgentActivity(tracked);
      return null;
    };
    act(() => root.render(<Probe tracked={new CountingSet(['a', 'b'])} />));
    act(() => listener?.(toolStart('a')));
    const rebuilt = new CountingSet(['b', 'a']);
    act(() => root.render(<Probe tracked={rebuilt} />));
    expect(rebuilt.lookups).toBe(0);
  });
});

describe('useAgentActivity pruning', () => {
  it('drops activity for an id that is no longer tracked', () => {
    let latest: ReadonlyMap<string, AgentActivity> = new Map();
    const Probe = ({ tracked }: { tracked: ReadonlySet<string> }) => {
      latest = useAgentActivity(tracked);
      return null;
    };
    act(() => root.render(<Probe tracked={new Set(['a', 'b'])} />));
    act(() => listener?.(toolStart('a')));
    act(() => listener?.(toolStart('b')));
    act(() => root.render(<Probe tracked={new Set(['b'])} />));
    expect([...latest.keys()]).toEqual(['b']);
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
