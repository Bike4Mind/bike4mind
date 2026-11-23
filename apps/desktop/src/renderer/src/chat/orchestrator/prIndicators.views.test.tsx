// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import { AgentPrIndicator } from './AgentPrIndicator';
import { FocusPanel } from './FocusPanel';
import type { OrchestratorViewProps } from './OrchestratorStage';
import { LAYOUT_PRESETS } from './orchestratorLayout';
import { ORCHESTRATOR_VIEWS } from './orchestratorViews';
import { redactForPresenter } from './presenter';
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
  it.each(ORCHESTRATOR_VIEWS)('%s shows PRs in every execution state, but not for agents without a PR', async view => {
    await themed.render(renderOrchestratorView(view, props));
    expect(agentIndicators()).toHaveLength(agents.length);
    agents.forEach(agent => {
      const indicator = document.querySelector(`[data-pr-number="${agent.pr!.number}"]`);
      expect(indicator?.textContent).toContain(`#${agent.pr!.number}`);
      expect(indicator?.getAttribute('aria-label')).toContain(agent.pr!.state === 'open' ? 'Open' : 'Merged');
      expect(indicator?.querySelector('[tabindex], button, a')).toBeNull();
    });
  });

  it.each(ORCHESTRATOR_VIEWS)('%s keeps PR metadata redacted for presenters', async view => {
    const redacted = redactForPresenter({ agents: roster, parent: {}, approvals: [] }, new Map());
    await themed.render(renderOrchestratorView(view, { ...props, agents: redacted.agents }));
    expect(indicators()).toHaveLength(0);
    agents.forEach(agent => expect(document.body.innerHTML).not.toContain(String(agent.pr!.number)));
  });

  it.each(ORCHESTRATOR_VIEWS)('%s opens the matching PR without selecting its agent', async view => {
    await themed.render(renderOrchestratorView(view, props));
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
  });

  it.each(Object.entries(LAYOUT_PRESETS))(
    '%s layout shows indicators in every pane without changing pane focus',
    async (_name, preset) => {
      await themed.render(
        <StageLayout
          layout={{
            split: preset.split,
            panes: ORCHESTRATOR_VIEWS.slice(0, preset.panes).map(view => ({ view, size: 1 / preset.panes })),
          }}
          onLayoutChange={vi.fn()}
          renderPane={view => renderOrchestratorView(view, props)}
        />
      );
      expect(agentIndicators()).toHaveLength(preset.panes * agents.length);
      if (preset.panes > 1) {
        const first = el('orchestrator-pane-0');
        const second = el('orchestrator-pane-1');
        act(() => {
          first.focus();
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true }));
        });
        expect(document.activeElement).toBe(second);
      }
    }
  );

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
  it.each([
    ['open', 'success.plainColor'],
    ['draft', 'text.tertiary'],
    ['queued', 'warning.plainColor'],
    ['merged', '#8250df'],
    ['closed', 'danger.plainColor'],
    ['OPEN', 'success.plainColor'],
    ['future-state', 'text.tertiary'],
  ])('%s uses the existing PR icon and color semantics', async (state, color) => {
    await themed.render(<AgentPrIndicator pr={{ number: 42, state }} />);
    expect(el('orchestrator-pr-indicator').querySelector('[data-pr-color]')?.getAttribute('data-pr-color')).toBe(color);
    expect(el('orchestrator-pr-indicator').textContent).toContain('#42');
  });

  it('removes the indicator when PR metadata disappears', async () => {
    await themed.render(<AgentPrIndicator pr={{ number: 42, state: 'merged' }} />);
    expect(indicators()).toHaveLength(1);
    await themed.render(<AgentPrIndicator pr={undefined} />);
    expect(indicators()).toHaveLength(0);
  });
});
