// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/chat';
import {
  FINALE_SETTLE_MS,
  finaleStats,
  formatWallTime,
  latestParentReport,
  reportFollowsAgents,
  runKey,
  useFinale,
  type ParentReport,
} from './finale';
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

describe('latestParentReport', () => {
  const at = '2026-10-01T00:05:00.000Z';
  const message = (extra: Partial<ChatMessage>): ChatMessage => ({
    id: 'm',
    role: 'assistant',
    content: 'All done.',
    createdAt: at,
    ...extra,
  });

  it("is the parent's last reply when it has text", () => {
    expect(latestParentReport([message({ id: 'p', role: 'user' }), message({ id: 's' })])).toEqual({
      id: 's',
      createdAt: at,
    });
  });

  it('is absent while an agent notice or a prompt follows the last reply', () => {
    expect(latestParentReport([message({}), message({ id: 'n', role: 'user', system: true })])).toBeUndefined();
    expect(latestParentReport([message({}), message({ id: 'u', role: 'user' })])).toBeUndefined();
    expect(latestParentReport([])).toBeUndefined();
  });

  it('is absent for a reply that is empty, failed or stopped', () => {
    expect(latestParentReport([message({ content: '  ' })])).toBeUndefined();
    expect(latestParentReport([message({ error: 'boom' })])).toBeUndefined();
    expect(latestParentReport([message({ stopReason: 'aborted' })])).toBeUndefined();
  });
});

describe('reportFollowsAgents', () => {
  it('holds only when the report was written at or after every agent last changed', () => {
    const report = { id: 's', createdAt: '2026-10-01T00:05:00.000Z' };
    expect(reportFollowsAgents(report, [agent('a', 'done', { updatedAt: '2026-10-01T00:05:00.000Z' })])).toBe(true);
    expect(reportFollowsAgents(report, [agent('a', 'done', { updatedAt: '2026-10-01T00:06:00.000Z' })])).toBe(false);
    expect(reportFollowsAgents({ id: 's', createdAt: '' }, [agent('a', 'done')])).toBe(false);
  });
});

describe('useFinale', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useFinale> | undefined;
  // Written after the fixtures' agents last changed.
  const summary = (id: string): ParentReport => ({ id, createdAt: '2026-10-01T00:10:00.000Z' });
  const S1 = summary('s1');
  const Probe = ({
    agents,
    parent,
    report,
    rootId = 'root',
  }: {
    agents: AgentView[];
    parent: ParentView;
    report?: ParentReport;
    rootId?: string;
  }) => {
    latest = useFinale(rootId, agents, parent, report);
    return null;
  };
  // null: the parent has no summary yet (undefined would take the default).
  const render = (agents: AgentView[], parent: ParentView = {}, report: ParentReport | null = S1) =>
    act(() => root.render(<Probe agents={agents} parent={parent} report={report ?? undefined} />));
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

  it('celebrates once every agent settles and the parent stops on a summary, after one was seen working', () => {
    render([agent('a', 'working'), agent('b', 'done')], { status: 'processing' }, null);
    render([agent('a', 'done'), agent('b', 'done')], { status: 'processing' }, null);
    settle();
    expect(latest?.shown).toBe(false);

    render([agent('a', 'done'), agent('b', 'done')], { status: 'done' });
    expect(latest?.shown).toBe(false);
    settle();
    expect(latest?.shown).toBe(true);
  });

  it('waits when the agents settle but the parent has not written a summary since', () => {
    render([agent('a', 'working')], { status: 'processing' }, null);
    render([agent('a', 'done')], { status: 'done' }, null);
    settle();
    expect(latest?.shown).toBe(false);

    // The last reply predates an agent's final change: it is not the report on that work.
    render([agent('a', 'done', { updatedAt: '2026-10-01T00:20:00.000Z' })], { status: 'done' }, S1);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('celebrates when the parent writes its summary after the agents settle', () => {
    render([agent('a', 'working')], { status: 'processing' }, null);
    render([agent('a', 'done')], { status: 'done' }, null);
    settle();
    render([agent('a', 'done')], { status: 'processing' }, null);
    render([agent('a', 'done')], { status: 'done' }, S1);
    settle();
    expect(latest?.shown).toBe(true);
  });

  it('celebrates again when the same agents re-run and the parent writes a new summary', () => {
    render([agent('a', 'working')], {}, null);
    render([agent('a', 'done')], {}, S1);
    settle();
    expect(latest?.shown).toBe(true);
    act(() => latest?.dismiss());

    render([agent('a', 'working')], { status: 'processing' }, null);
    render([agent('a', 'done')], { status: 'done' }, null);
    settle();
    expect(latest?.shown).toBe(false);
    render([agent('a', 'done')], { status: 'done' }, summary('s2'));
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

  it('remembers a seen completion so a reload never replays it, and dismiss hides it', () => {
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

  it('does not celebrate again when an agent of a finished run is archived or deleted', () => {
    render([agent('a', 'working'), agent('b', 'working')]);
    render([agent('a', 'done'), agent('b', 'done')]);
    settle();
    act(() => latest?.dismiss());

    render([agent('a', 'done')]);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('hides the banner if an agent picks up work again', () => {
    render([agent('a', 'working')]);
    render([agent('a', 'done')]);
    settle();
    render([agent('a', 'working')]);
    expect(latest?.shown).toBe(false);
  });
});
