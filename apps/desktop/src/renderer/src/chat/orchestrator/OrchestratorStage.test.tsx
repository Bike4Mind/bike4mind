// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorStage } from './OrchestratorStage';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query, typeInto } from './testUtils';

const FIXTURE = [
  agentFixture('n', 'needs-you', { usdCost: 1 }),
  agentFixture('w1', 'working', { usdCost: 1 }),
  agentFixture('w2', 'working', { usdCost: 1 }),
  agentFixture('d', 'done'),
];

const onViewChange = vi.fn();
const actions = { open: vi.fn(), stop: vi.fn(), archive: vi.fn() };
const themed = createThemedMount();

const onDelegateChange = vi.fn();

const renderStage = (agents: AgentView[], dockControl?: ReactNode, delegate?: boolean) =>
  themed.render(
    <OrchestratorStage
      agents={agents}
      view="table"
      onViewChange={onViewChange}
      actions={actions}
      introPlaying={false}
      dockControl={dockControl}
      delegate={delegate === undefined ? undefined : { on: delegate, onChange: onDelegateChange }}
    />
  );

const pressEscape = (init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...init }));
  });

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: { getSession: vi.fn().mockResolvedValue(null), onQueueChanged: vi.fn(() => () => undefined) },
  };
});

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('OrchestratorStage', () => {
  it('shows an empty state instead of a view while there are no agents', async () => {
    await renderStage([]);
    expect(el('orchestrator-empty-state').textContent).toBe(
      'No agents yet. Describe the work and it will be split across agents.'
    );
    expect(query('orchestrator-table')).toBeNull();

    await renderStage([agentFixture('w', 'working')]);
    expect(query('orchestrator-empty-state')).toBeNull();
    expect(query('orchestrator-table-row-w')).not.toBeNull();
  });

  it('reflects and sets the delegate switch, and leaves it out when not offered', async () => {
    await renderStage([], undefined, true);
    const input = () => el('orchestrator-delegate-switch').querySelector('input');
    expect(el('orchestrator-delegate-switch').textContent).toContain('Delegate to agents');
    expect(input()?.checked).toBe(true);
    act(() => input()?.click());
    expect(onDelegateChange).toHaveBeenCalledWith(false);

    await renderStage([], undefined, false);
    expect(input()?.checked).toBe(false);
    act(() => input()?.click());
    expect(onDelegateChange).toHaveBeenLastCalledWith(true);

    await renderStage([]);
    expect(query('orchestrator-delegate-switch')).toBeNull();
  });

  it('summarises the roster, with ~ when a cost is unknown', async () => {
    await renderStage(FIXTURE);
    expect(query('orchestrator-summary-strip')?.textContent).toBe(
      '4 agents \u00B7 2 working \u00B7 1 need you \u00B7 1 done \u00B7 0 failed \u00B7 ~$3.00'
    );
  });

  it('uses the singular for one agent', async () => {
    await renderStage([agentFixture('w', 'working', { usdCost: 0.5 })]);
    expect(query('orchestrator-summary-strip')?.textContent).toBe(
      '1 agent \u00B7 1 working \u00B7 0 need you \u00B7 0 done \u00B7 0 failed \u00B7 $0.50'
    );
  });

  it('marks the dollar total partial when an agent only reported credits', async () => {
    await renderStage([agentFixture('a', 'done', { usdCost: 1 }), agentFixture('b', 'done', { credits: 4 })]);
    expect(query('orchestrator-summary-strip')?.textContent).toContain('\u00B7 ~$1.00');
  });

  it('shows credits when no agent reported dollars', async () => {
    await renderStage([agentFixture('a', 'done', { credits: 4 }), agentFixture('b', 'done', { credits: 2 })]);
    expect(query('orchestrator-summary-strip')?.textContent).toContain('\u00B7 6 cr');
  });

  it('hides the needs-you pill when nothing needs the user', async () => {
    await renderStage([agentFixture('w', 'working')]);
    expect(query('orchestrator-needs-you-pill')).toBeNull();
  });

  it('opens the drawer for the first needs-you agent from the pill and closes on Escape', async () => {
    await renderStage(FIXTURE);
    expect(query('orchestrator-peek-drawer')).toBeNull();
    await act(async () => el('orchestrator-needs-you-pill').click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent n');
    await pressEscape();
    expect(query('orchestrator-peek-drawer')).toBeNull();
  });

  it('keeps the drawer open for an Escape that is composing or already handled', async () => {
    await renderStage(FIXTURE);
    await act(async () => el('orchestrator-needs-you-pill').click());
    await pressEscape({ isComposing: true });
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    act(() => {
      const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      handled.preventDefault();
      window.dispatchEvent(handled);
    });
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
  });

  it('opens the drawer when a table row is clicked', async () => {
    await renderStage(FIXTURE);
    await act(async () => el('orchestrator-table-row-w2').click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent w2');
  });

  it('starts a fresh reply box when another agent is selected', async () => {
    await renderStage(FIXTURE);
    await act(async () => el('orchestrator-table-row-w1').click());
    await typeInto(el('orchestrator-peek-reply-input') as HTMLTextAreaElement, 'half-written');
    await act(async () => el('orchestrator-table-row-w2').click());
    expect((el('orchestrator-peek-reply-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('reports a view change', async () => {
    await renderStage(FIXTURE);
    act(() => el('orchestrator-view-tab-board').click());
    expect(onViewChange).toHaveBeenCalledWith('board');
  });

  it('renders the dock control in the header', async () => {
    await renderStage(FIXTURE, <span data-testid="dock-probe" />);
    expect(query('dock-probe')).not.toBeNull();
  });

  describe('the finale', () => {
    const onReadReport = vi.fn();
    const renderRun = (agents: AgentView[], parent: { status?: 'processing' | 'done' } = {}) =>
      themed.render(
        <OrchestratorStage
          agents={agents}
          parent={parent}
          rootId="root"
          view="table"
          onViewChange={onViewChange}
          actions={actions}
          introPlaying={false}
          onReadReport={onReadReport}
        />
      );
    const finished = [
      agentFixture('a', 'done', {
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:03:12.000Z',
        usdCost: 1.5,
      }),
      agentFixture('b', 'failed', { usdCost: 0.25 }),
    ];

    beforeEach(() => {
      window.localStorage.clear();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => vi.useRealTimers());

    const settle = () =>
      act(async () => {
        vi.advanceTimersByTime(5000);
      });

    it('shows a banner with the run stats once the run completes, over any view', async () => {
      await renderRun([agentFixture('a', 'working'), agentFixture('b', 'working')], { status: 'processing' });
      await renderRun(finished, { status: 'done' });
      expect(query('orchestrator-finale')).toBeNull();
      await settle();
      const banner = el('orchestrator-finale');
      expect(banner.textContent).toContain('Quest complete');
      expect(el('orchestrator-finale-stats').textContent).toBe(
        '2 agents \u00B7 3m 12s \u00B7 $1.75 \u00B7 1 done \u00B7 1 failed'
      );
      expect(query('orchestrator-table')).not.toBeNull();
    });

    it('reads the report and dismisses the banner', async () => {
      await renderRun([agentFixture('a', 'working')]);
      await renderRun(finished);
      await settle();
      await act(async () => el('orchestrator-finale-read-btn').click());
      expect(onReadReport).toHaveBeenCalledTimes(1);
      expect(query('orchestrator-finale')).toBeNull();
    });

    it('dismisses without reading', async () => {
      await renderRun([agentFixture('a', 'working')]);
      await renderRun(finished);
      await settle();
      await act(async () => el('orchestrator-finale-dismiss-btn').click());
      expect(query('orchestrator-finale')).toBeNull();
      expect(onReadReport).not.toHaveBeenCalled();
    });

    it('tells the views to celebrate while the banner is up', async () => {
      const seen: boolean[] = [];
      const renderView = (_view: string, props: { celebrating?: boolean }) => {
        seen.push(props.celebrating ?? false);
        return null;
      };
      const renderWith = (agents: AgentView[]) =>
        themed.render(
          <OrchestratorStage
            agents={agents}
            rootId="root"
            view="tavern"
            onViewChange={onViewChange}
            actions={actions}
            introPlaying={false}
            renderView={renderView}
          />
        );
      await renderWith([agentFixture('a', 'working')]);
      await renderWith(finished);
      expect(seen.at(-1)).toBe(false);
      await settle();
      expect(seen.at(-1)).toBe(true);
    });
  });
});
