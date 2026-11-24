// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import { AgentPrIndicator } from './AgentPrIndicator';
import { FocusPanel } from './FocusPanel';
import type { OrchestratorViewProps } from './OrchestratorStage';
import { LAYOUT_PRESETS } from './orchestratorLayout';
import { ORCHESTRATOR_VIEWS } from './orchestratorViews';
import { StageLayout } from './StageLayout';
import { agentFixture, createThemedMount, el, viewAgentFixture, snapshotFixture } from './testUtils';
import { renderOrchestratorView } from './viewRegistry';
import { OverflowStack } from './tavern/OverflowStack';

const themed = createThemedMount();
const onSelect = vi.fn();
const onOpenPr = vi.fn();
const states = ['working', 'needs-you', 'done', 'failed', 'idle', 'stopped'] as const;
const agents = states.map((state, index) =>
  agentFixture(state, state, {
    pr: { number: 8100 + index, state: index % 2 === 0 ? 'open' : 'merged' },
  })
);
const roster = [...agents, agentFixture('no-pr')];
const props: OrchestratorViewProps = {
  agents: roster,
  parent: {},
  rootId: 'root',
  onSelect,
  onOpenPr,
  selectedId: null,
  introPlaying: false,
  personas: assignPersonas(roster),
};
const indicators = (root: ParentNode = document) => [...root.querySelectorAll('[data-pr-number]')];
const agentIndicators = () =>
  indicators().filter(badge => !badge.closest('[data-testid="orchestrator-tavern-quest-board"]'));

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      onStreamEvent: vi.fn(() => () => undefined),
      onQueueChanged: vi.fn(() => () => undefined),
    },
  };
});
afterEach(() => {
  themed.unmount();
  onSelect.mockClear();
  onOpenPr.mockClear();
});

describe('PR indicators across Show agents views', () => {
  // Presenter redaction of PR numbers on every view is covered in presenter.views.test.tsx.
  it.each(ORCHESTRATOR_VIEWS)(
    '%s shows PRs in every execution state, and opens one without selecting its agent',
    async view => {
      await themed.render(renderOrchestratorView(view, props));
      expect(agentIndicators(), 'one per agent with a PR, none without').toHaveLength(agents.length);
      agents.forEach(agent => {
        const indicator = document.querySelector(`[data-pr-number="${agent.pr!.number}"]`);
        expect(indicator?.textContent).toContain(`#${agent.pr!.number}`);
        expect(indicator?.getAttribute('aria-label')).toContain(agent.pr!.state === 'open' ? 'Open' : 'Merged');
        expect(indicator?.querySelector('[tabindex], button, a')).toBeNull();
      });

      const badge = indicators()[0] as HTMLButtonElement;
      const agent = agents.find(item => String(item.pr!.number) === badge.dataset.prNumber)!;
      expect(badge.tagName).toBe('BUTTON');
      expect(badge.parentElement?.closest('button')).toBeNull();
      act(() => {
        badge.focus();
        badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        badge.click();
      });
      expect(onOpenPr).toHaveBeenCalledWith(agent.id);
      expect(onSelect).not.toHaveBeenCalled();
      onOpenPr.mockClear();
      act(() => {
        badge.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        badge.click();
      });
      expect(onOpenPr).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    }
  );

  // The other presets differ only in pane count and split direction, which StageLayout.test.tsx covers.
  it('a split layout shows indicators in every pane without changing pane focus', async () => {
    const preset = LAYOUT_PRESETS['three-across'];
    await themed.render(
      <StageLayout
        layout={{
          split: preset.split,
          panes: ORCHESTRATOR_VIEWS.slice(0, preset.panes).map(view => ({ view, size: 1 / preset.panes })),
        }}
        onLayoutChange={vi.fn()}
        renderPane={pane => renderOrchestratorView(pane.view, props)}
      />
    );
    expect(agentIndicators()).toHaveLength(preset.panes * agents.length);
    const first = el('orchestrator-pane-0');
    act(() => {
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true }));
    });
    expect(document.activeElement).toBe(el('orchestrator-pane-1'));
  });

  it('Focus mode shows PRs for attention, working and quiet agents', async () => {
    const onAction = vi.fn();
    await themed.render(
      <FocusPanel
        snapshot={snapshotFixture(
          states.map((state, index) =>
            viewAgentFixture(state, state, { pr: { number: 8100 + index, state: 'closed' } })
          )
        )}
        onAction={onAction}
      />
    );
    expect(indicators()).toHaveLength(states.length);
    for (const badge of indicators()) {
      const index = Number((badge as HTMLElement).dataset.prNumber) - 8100;
      act(() => (badge as HTMLButtonElement).click());
      expect(onAction).toHaveBeenLastCalledWith({ kind: 'open-pr', agentId: states[index] });
    }
  });

  it('the overflow menu shows PRs without changing agent selection', async () => {
    await themed.render(
      <OverflowStack
        zone="workbench"
        point={{ x: 50, y: 50 }}
        stacked={[{ agent: agents[0], character: 1, name: 'Worker' }]}
        selectedId={null}
        onSelect={onSelect}
        onOpenPr={onOpenPr}
      />
    );
    act(() => el('orchestrator-tavern-overflow-workbench').click());
    expect(indicators(el('orchestrator-tavern-overflow-workbench-list'))).toHaveLength(1);
    act(() => (indicators()[0] as HTMLButtonElement).click());
    expect(onOpenPr).toHaveBeenCalledWith('working');
    expect(onSelect).not.toHaveBeenCalled();
    act(() => el('orchestrator-tavern-overflow-item-working').click());
    expect(onSelect).toHaveBeenCalledWith('working');
  });
});

describe('PR state presentation', () => {
  it('uses the existing PR icon and color semantics per state, and goes away with the PR metadata', async () => {
    const colors: [string, string][] = [
      ['open', 'success.plainColor'],
      ['draft', 'text.tertiary'],
      ['queued', 'warning.plainColor'],
      ['merged', '#8250df'],
      ['closed', 'danger.plainColor'],
      ['OPEN', 'success.plainColor'],
      ['future-state', 'text.tertiary'],
    ];
    for (const [state, color] of colors) {
      await themed.render(<AgentPrIndicator pr={{ number: 42, state }} />);
      const indicator = el('orchestrator-pr-indicator');
      expect(indicator.querySelector('[data-pr-color]')?.getAttribute('data-pr-color'), state).toBe(color);
      expect(indicator.textContent).toContain('#42');
    }
    await themed.render(<AgentPrIndicator pr={undefined} />);
    expect(indicators()).toHaveLength(0);
  });
});
