// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/chat';
import {
  FINALE_SETTLE_MS,
  finaleStats,
  formatWallTime,
  latestQuestReport,
  questSucceeded,
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

describe('latestQuestReport', () => {
  const at = '2026-10-01T00:05:00.000Z';
  const message = (extra: Partial<ChatMessage>): ChatMessage => ({
    id: 'm',
    role: 'assistant',
    content: 'All done.',
    createdAt: at,
    ...extra,
  });

  it('is the newest reply marked by quest_complete, wherever it sits', () => {
    expect(
      latestQuestReport([
        message({ id: 'q1', questComplete: true }),
        message({ id: 'q2', questComplete: true }),
        message({ id: 'n', role: 'user', system: true }),
        message({ id: 'later' }),
      ])
    ).toEqual({ id: 'q2', createdAt: at });
  });

  it('ignores an unmarked reply however final it looks', () => {
    expect(latestQuestReport([message({ id: 'p', role: 'user' }), message({ id: 'waiting' })])).toBeUndefined();
    expect(latestQuestReport([])).toBeUndefined();
  });
});

describe('questSucceeded', () => {
  it('holds only when every agent ended done', () => {
    expect(questSucceeded(finaleStats([agent('a', 'done'), agent('b', 'done')]))).toBe(true);
    expect(questSucceeded(finaleStats([agent('a', 'done'), agent('b', 'failed')]))).toBe(false);
    expect(questSucceeded(finaleStats([agent('a', 'done'), agent('b', 'idle')]))).toBe(false);
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

  it('celebrates a quest_complete summary once the agents and the parent have settled', () => {
    render([agent('a', 'working'), agent('b', 'done')], { status: 'processing' }, null);
    render([agent('a', 'done'), agent('b', 'done')], { status: 'processing' }, S1);
    settle();
    expect(latest?.shown).toBe(false);

    render([agent('a', 'done'), agent('b', 'done')], { status: 'done' });
    expect(latest?.shown).toBe(false);
    settle();
    expect(latest?.shown).toBe(true);
  });

  it('never celebrates without a marked summary, however settled the run looks', () => {
    render([agent('a', 'working')], { status: 'processing' }, null);
    render([agent('a', 'done')], { status: 'done' }, null);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('shows a summary marked while the stage was elsewhere, once', () => {
    render([agent('a', 'done')], { status: 'done' });
    settle();
    expect(latest?.shown).toBe(true);
  });

  it('does not count a needs-you agent as settled', () => {
    render([agent('a', 'needs-you')]);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('waits out a brief settle so a parent picking straight back up does not trigger it', () => {
    render([agent('a', 'done')], { status: 'done' });
    act(() => {
      vi.advanceTimersByTime(FINALE_SETTLE_MS / 2);
    });
    render([agent('a', 'done')], { status: 'processing' });
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('remembers a shown summary so a reload never replays it, and dismiss hides it', () => {
    render([agent('a', 'done')]);
    settle();
    expect(latest?.shown).toBe(true);
    act(() => latest?.dismiss());
    expect(latest?.shown).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    render([agent('a', 'done')]);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('celebrates again for a later quest_complete in the same session', () => {
    render([agent('a', 'done')], {}, S1);
    settle();
    act(() => latest?.dismiss());

    render([agent('a', 'working')], { status: 'processing' }, S1);
    render([agent('a', 'done')], { status: 'done' }, S1);
    settle();
    expect(latest?.shown).toBe(false);

    render([agent('a', 'done')], { status: 'done' }, summary('s2'));
    settle();
    expect(latest?.shown).toBe(true);
  });

  it('does not celebrate again when an agent of a finished run is archived or deleted', () => {
    render([agent('a', 'done'), agent('b', 'done')]);
    settle();
    act(() => latest?.dismiss());

    render([agent('a', 'done')]);
    settle();
    expect(latest?.shown).toBe(false);
  });

  it('hides the banner if an agent picks up work again', () => {
    render([agent('a', 'done')]);
    settle();
    expect(latest?.shown).toBe(true);
    render([agent('a', 'working')]);
    expect(latest?.shown).toBe(false);
  });
});
