// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINALE_SETTLE_MS, finaleStats, formatWallTime, runKey, useFinale } from './finale';
import type { AgentState, AgentView, ParentView } from './roster';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, state: AgentState, extra: Partial<AgentView> = {}): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
  ...extra,
});

describe('finaleStats', () => {
  it('counts agents and outcomes, spans first creation to last update, and totals the cost', () => {
    const stats = finaleStats([
      agent('a', 'done', { createdAt: '2026-10-01T00:00:10.000Z', updatedAt: '2026-10-01T00:02:00.000Z', usdCost: 1 }),
      agent('b', 'failed', {
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:03:12.000Z',
        usdCost: 0.5,
      }),
      agent('c', 'done', { updatedAt: '2026-10-01T00:01:00.000Z', usdCost: 0.25 }),
    ]);
    expect(stats).toEqual({ agents: 3, wallMs: 192_000, cost: '$1.75', done: 2, failed: 1 });
  });

  it('marks a partial cost and shows a dash when nobody reported one', () => {
    expect(finaleStats([agent('a', 'done', { usdCost: 1 }), agent('b', 'done')]).cost).toBe('~$1.00');
    expect(finaleStats([agent('a', 'done')]).cost).toBe('-');
  });
});

describe('formatWallTime', () => {
  it('reads as seconds, minutes and seconds, or hours and minutes', () => {
    expect(formatWallTime(45_000)).toBe('45s');
    expect(formatWallTime(192_000)).toBe('3m 12s');
    expect(formatWallTime(3_840_000)).toBe('1h 04m');
    expect(formatWallTime(-5)).toBe('0s');
  });
});

describe('runKey', () => {
  it('names a run by its agents, whatever their order or state', () => {
    expect(runKey([agent('a', 'done'), agent('b', 'failed')])).toBe(
      runKey([agent('b', 'working'), agent('a', 'idle')])
    );
    expect(runKey([agent('a', 'done')])).not.toBe(runKey([agent('a', 'done'), agent('c', 'done')]));
  });
});

describe('useFinale', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useFinale> | undefined;
  const Probe = ({ agents, parent, rootId = 'root' }: { agents: AgentView[]; parent: ParentView; rootId?: string }) => {
    latest = useFinale(rootId, agents, parent);
    return null;
  };
  const render = (agents: AgentView[], parent: ParentView = {}, rootId?: string) =>
    act(() => root.render(<Probe agents={agents} parent={parent} rootId={rootId} />));
  const settle = () =>
    act(() => {
      vi.advanceTimersByTime(FINALE_SETTLE_MS + 10);
    });

  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('celebrates once every agent settles and the parent stops, after one was seen working', () => {
    render([agent('a', 'working'), agent('b', 'done')], { status: 'processing' });
    render([agent('a', 'done'), agent('b', 'done')], { status: 'processing' });
    settle();
    expect(latest?.shown).toBe(false);

    render([agent('a', 'done'), agent('b', 'done')], { status: 'done' });
    expect(latest?.shown).toBe(false);
    settle();
    expect(latest?.shown).toBe(true);
  });

  it('never celebrates a run that was already over when the stage mounted', () => {
    render([agent('a', 'done')], { status: 'done' });
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('does not count a needs-you agent as settled', () => {
    render([agent('a', 'working')]);
    render([agent('a', 'needs-you')]);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('waits out a brief settle so a parent picking straight back up does not trigger it', () => {
    render([agent('a', 'working')], { status: 'processing' });
    render([agent('a', 'done')], { status: 'done' });
    act(() => {
      vi.advanceTimersByTime(FINALE_SETTLE_MS / 2);
    });
    render([agent('a', 'done')], { status: 'processing' });
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('remembers a seen run so it never replays, and dismiss hides it', () => {
    render([agent('a', 'working')]);
    render([agent('a', 'done')]);
    settle();
    expect(latest?.shown).toBe(true);
    act(() => latest?.dismiss());
    expect(latest?.shown).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    render([agent('a', 'working')]);
    render([agent('a', 'done')]);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('celebrates again for a new run with new agents', () => {
    render([agent('a', 'working')]);
    render([agent('a', 'done')]);
    settle();
    act(() => latest?.dismiss());
    render([agent('a', 'done'), agent('b', 'working')]);
    render([agent('a', 'done'), agent('b', 'done')]);
    settle();
    expect(latest?.shown).toBe(true);
  });

  it('hides the banner if an agent picks up work again', () => {
    render([agent('a', 'working')]);
    render([agent('a', 'done')]);
    settle();
    render([agent('a', 'working')]);
    expect(latest?.shown).toBe(false);
  });
});
