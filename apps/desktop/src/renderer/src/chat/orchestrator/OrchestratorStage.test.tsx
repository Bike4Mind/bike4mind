// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorStage, type OrchestratorViewProps } from './OrchestratorStage';
import { EXAMPLE_QUESTS } from './exampleQuests';
import type { AgentView } from './roster';
import { TavernView } from './tavern/TavernView';
import { agentFixture, createThemedMount, el, query, typeInto } from './testUtils';

const FIXTURE = [
  agentFixture('n', 'needs-you', { usdCost: 1 }),
  agentFixture('w1', 'working', { usdCost: 1 }),
  agentFixture('w2', 'working', { usdCost: 1 }),
  agentFixture('d', 'done'),
];

const chime = vi.hoisted(() => ({ playChime: vi.fn() }));
vi.mock('./chime', () => chime);

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
    expect(el('orchestrator-empty-state').textContent).toContain(
      'No agents yet. Describe the work and it will be split across agents.'
    );
    expect(query('orchestrator-table')).toBeNull();

    await renderStage([agentFixture('w', 'working')]);
    expect(query('orchestrator-empty-state')).toBeNull();
    expect(query('orchestrator-table-row-w')).not.toBeNull();
  });

  describe('example quests', () => {
    const onExampleQuest = vi.fn();
    const renderEmpty = (view: 'tavern' | 'board' | 'table') =>
      themed.render(
        <OrchestratorStage
          agents={[]}
          view={view}
          onViewChange={onViewChange}
          actions={actions}
          introPlaying={false}
          renderView={(id, props: OrchestratorViewProps) =>
            id === 'tavern' ? <TavernView {...props} /> : <div data-testid={`fake-${id}`} />
          }
          onExampleQuest={onExampleQuest}
        />
      );

    it('welcomes an empty tavern with the Innkeeper idle behind the bar', async () => {
      await renderEmpty('tavern');
      const empty = el('orchestrator-empty-state');
      expect(empty.querySelector('[data-testid="orchestrator-tavern"]')).not.toBeNull();
      expect(el('orchestrator-tavern-innkeeper').getAttribute('data-pose')).toBe('idle');
      expect(empty.textContent).toContain(
        'No quests yet. Describe the work and the Innkeeper will split it across agents.'
      );
    });

    it.each(['tavern', 'board', 'table'] as const)('offers three example quests in the %s view', async view => {
      await renderEmpty(view);
      expect(query(`fake-${view}`)).toBeNull();
      expect(EXAMPLE_QUESTS.map((_quest, index) => el(`orchestrator-example-quest-${index + 1}`).textContent)).toEqual([
        'Audit this repo',
        'Write missing tests',
        'Compare approaches',
      ]);
      act(() => el('orchestrator-example-quest-2').click());
      expect(onExampleQuest).toHaveBeenLastCalledWith(EXAMPLE_QUESTS[1].prompt);
    });

    it('keeps the plain empty line in the board and table views', async () => {
      await renderEmpty('board');
      expect(el('orchestrator-empty-state').textContent).toContain(
        'No agents yet. Describe the work and it will be split across agents.'
      );
      expect(query('orchestrator-tavern')).toBeNull();
    });
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
      '4 agents \u00B7 2 working \u00B7 1 done \u00B7 ~$3.00'
    );
  });

  it('uses the singular for one agent', async () => {
    await renderStage([agentFixture('w', 'working', { usdCost: 0.5 })]);
    expect(query('orchestrator-summary-strip')?.textContent).toBe('1 agent \u00B7 1 working \u00B7 $0.50');
  });

  it('marks the dollar total partial when an agent only reported credits', async () => {
    await renderStage([agentFixture('a', 'done', { usdCost: 1 }), agentFixture('b', 'done', { credits: 4 })]);
    expect(query('orchestrator-summary-strip')?.textContent).toContain('\u00B7 ~$1.00');
  });

  it('shows credits when no agent reported dollars', async () => {
    await renderStage([agentFixture('a', 'done', { credits: 4 }), agentFixture('b', 'done', { credits: 2 })]);
    expect(query('orchestrator-summary-strip')?.textContent).toContain('\u00B7 6 cr');
  });

  it('counts the parent waiting on an approval as needing the user, and its pill opens the parent', async () => {
    const onParentFocus = vi.fn();
    await themed.render(
      <OrchestratorStage
        agents={[agentFixture('w', 'working')]}
        parent={{ status: 'needs-action' }}
        onParentFocus={onParentFocus}
        view="table"
        onViewChange={onViewChange}
        actions={actions}
        introPlaying={false}
      />
    );
    expect(el('orchestrator-needs-you-pill').textContent).toBe('1 need you');
    expect(el('orchestrator-summary-strip').textContent).not.toContain('need you');
    await act(async () => el('orchestrator-needs-you-pill').click());
    expect(onParentFocus).toHaveBeenCalledTimes(1);
    expect(query('orchestrator-peek-drawer')).toBeNull();
  });

  it('opens the first failed agent from the failed pill, and leaves it out when none failed', async () => {
    await renderStage([agentFixture('d', 'done'), agentFixture('f', 'failed'), agentFixture('g', 'failed')]);
    expect(el('orchestrator-summary-strip').textContent).not.toContain('failed');
    expect(el('orchestrator-failed-pill').textContent).toBe('2 failed');
    await act(async () => el('orchestrator-failed-pill').click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent f');

    await renderStage(FIXTURE);
    expect(query('orchestrator-failed-pill')).toBeNull();
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
    act(() => el('orchestrator-view-menu-btn').click());
    act(() => el('orchestrator-view-option-board').click());
    expect(onViewChange).toHaveBeenCalledWith('board');
  });

  it('renders the dock control in the header', async () => {
    await renderStage(FIXTURE, <span data-testid="dock-probe" />);
    expect(query('dock-probe')).not.toBeNull();
  });

  describe('the finale', () => {
    const onReadReport = vi.fn();
    const REPORT = { id: 'summary-1', createdAt: '2026-10-01T00:10:00.000Z' };
    const renderRun = (agents: AgentView[], parent: { status?: 'processing' | 'done' } = {}) =>
      themed.render(
        <OrchestratorStage
          agents={agents}
          parent={parent}
          rootId="root"
          report={REPORT}
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
      // One of the two failed, so the run ended rather than completed.
      expect(banner.textContent).toContain('Quest ended');
      expect(banner.getAttribute('data-outcome')).toBe('ended');
      const chips = [...el('orchestrator-finale-stats').querySelectorAll('li')].map(chip => chip.textContent);
      expect(chips).toEqual(['2 agents', '3m 12s', '$1.75', '1 done', '1 failed']);
      expect(query('orchestrator-table')).not.toBeNull();
    });

    it('says "Quest complete" only when every agent finished done', async () => {
      const allDone = [agentFixture('a', 'done'), agentFixture('b', 'done')];
      await renderRun([agentFixture('a', 'working'), agentFixture('b', 'working')], { status: 'processing' });
      await renderRun(allDone, { status: 'done' });
      await settle();
      const banner = el('orchestrator-finale');
      expect(banner.textContent).toContain('Quest complete');
      expect(banner.getAttribute('aria-label')).toBe('Quest complete');
      expect(banner.getAttribute('data-outcome')).toBe('complete');
      const chips = [...el('orchestrator-finale-stats').querySelectorAll('li')].map(chip => chip.textContent);
      expect(chips[0]).toBe('All 2 agents done');
      expect(chips.some(chip => chip?.includes('failed'))).toBe(false);
    });

    it('says "Quest ended" when an agent never finished', async () => {
      await renderRun([agentFixture('a', 'done'), agentFixture('b', 'idle')], { status: 'done' });
      await settle();
      expect(el('orchestrator-finale').getAttribute('aria-label')).toBe('Quest ended');
    });

    it('chimes once as the banner comes up', async () => {
      await renderRun([agentFixture('a', 'working')]);
      await renderRun(finished);
      expect(chime.playChime).not.toHaveBeenCalled();
      await settle();
      await renderRun(finished);
      expect(chime.playChime).toHaveBeenCalledTimes(1);
    });

    it('reads the report and dismisses the banner', async () => {
      await renderRun([agentFixture('a', 'working')]);
      await renderRun(finished);
      await settle();
      await act(async () => el('orchestrator-finale-read-btn').click());
      expect(onReadReport).toHaveBeenCalledTimes(1);
      expect(onReadReport).toHaveBeenCalledWith('summary-1');
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
            report={REPORT}
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

    it('seats the banner on the tavern scene rather than above it', async () => {
      const renderTavern = (agents: AgentView[]) =>
        themed.render(
          <OrchestratorStage
            agents={agents}
            rootId="root"
            report={REPORT}
            view="tavern"
            onViewChange={onViewChange}
            actions={actions}
            introPlaying={false}
            renderView={(_view, props) => <TavernView {...props} />}
          />
        );
      await renderTavern([agentFixture('a', 'working')]);
      await renderTavern(finished);
      await settle();
      expect(el('orchestrator-tavern').contains(el('orchestrator-finale'))).toBe(true);
    });

    it('waits for the parent to write its summary', async () => {
      const renderNoReport = (agents: AgentView[]) =>
        themed.render(
          <OrchestratorStage
            agents={agents}
            rootId="root"
            view="table"
            onViewChange={onViewChange}
            actions={actions}
            introPlaying={false}
          />
        );
      await renderNoReport([agentFixture('a', 'working')]);
      await renderNoReport(finished);
      await settle();
      expect(query('orchestrator-finale')).toBeNull();
    });
  });

  it('opens the agent a notice asked for, once, and says it was taken', async () => {
    const onFocusAgentConsumed = vi.fn();
    const renderFocus = (focusAgent: string | null) =>
      themed.render(
        <OrchestratorStage
          agents={FIXTURE}
          view="table"
          onViewChange={onViewChange}
          actions={actions}
          introPlaying={false}
          focusAgent={focusAgent}
          onFocusAgentConsumed={onFocusAgentConsumed}
        />
      );
    await renderFocus('n');
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    expect(onFocusAgentConsumed).toHaveBeenCalledTimes(1);
  });
});
