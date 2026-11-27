// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@shared/agentState';
import { snapshotFixture, viewAgentFixture, createThemedMount, el, query } from './testUtils';

import { Swimlanes } from './Swimlanes';

const themed = createThemedMount();
const onAction = vi.fn();
const STATES: readonly AgentState[] = ['needs-you', 'working', 'done', 'failed', 'stopped', 'idle'];
const COLORS: Record<AgentState, string> = {
  'needs-you': 'warning',
  working: 'primary',
  waiting: 'primary',
  done: 'success',
  failed: 'danger',
  paused: 'neutral',
  stopped: 'neutral',
  idle: 'neutral',
};

afterEach(() => {
  themed.unmount();
  onAction.mockReset();
});

const laneIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="orchestrator-swimlanes-lane-"]')).map(lane =>
    lane.dataset.testid?.replace('orchestrator-swimlanes-lane-', '')
  );

describe('Swimlanes', () => {
  it.each(STATES)('shows a %s agent with its state chip and dot colour', async state => {
    await themed.render(
      <Swimlanes
        snapshot={snapshotFixture([viewAgentFixture('a', state, { now: 'Doing a thing' })])}
        onAction={onAction}
      />
    );
    const lane = el('orchestrator-swimlanes-lane-a');
    expect(lane.dataset.state).toBe(state);
    expect(lane.querySelector('[data-testid="orchestrator-swimlanes-dot"]')?.getAttribute('data-color')).toBe(
      COLORS[state]
    );
    expect(lane.querySelector('[data-testid="orchestrator-swimlanes-chip"]')?.textContent).not.toBe('');
  });

  it('keeps the roster order and indents nested agents by depth', async () => {
    await themed.render(
      <Swimlanes
        snapshot={snapshotFixture([
          viewAgentFixture('top', 'working'),
          viewAgentFixture('child', 'working', { parentId: 'top', depth: 2 }),
          viewAgentFixture('grand', 'done', { parentId: 'child', depth: 3 }),
        ])}
        onAction={onAction}
      />
    );
    expect(laneIds()).toEqual(['top', 'child', 'grand']);
    const padding = (id: string) => parseFloat(getComputedStyle(el(`orchestrator-swimlanes-lane-${id}`)).paddingLeft);
    expect(padding('child')).toBeGreaterThan(padding('top'));
    expect(padding('grand')).toBeGreaterThan(padding('child'));
  });

  it('nests each child under its parent when the roster arrives in urgency order', async () => {
    // Real roster order: needs-you first, then working, then done; a child can precede its parent.
    await themed.render(
      <Swimlanes
        snapshot={snapshotFixture([
          viewAgentFixture('grand', 'needs-you', { parentId: 'child', depth: 3 }),
          viewAgentFixture('other', 'working'),
          viewAgentFixture('child', 'working', { parentId: 'top', depth: 2 }),
          viewAgentFixture('top', 'done'),
        ])}
        onAction={onAction}
      />
    );
    expect(laneIds()).toEqual(['other', 'top', 'child', 'grand']);
  });

  it('shows the activity line, or the pending question for an agent that needs the user', async () => {
    await themed.render(
      <Swimlanes
        snapshot={snapshotFixture([
          viewAgentFixture('w', 'working', { now: 'Running the test suite' }),
          viewAgentFixture('ask', 'needs-you'),
        ])}
        onAction={onAction}
      />
    );
    const line = (id: string) =>
      el(`orchestrator-swimlanes-lane-${id}`).querySelector('[data-testid="orchestrator-swimlanes-line"]')?.textContent;
    expect(line('w')).toBe('Running the test suite');
    expect(line('ask')).toBe('Question from ask?');
  });

  it('opens the agent on click, and the conversation from the root lane', async () => {
    await themed.render(
      <Swimlanes snapshot={snapshotFixture([viewAgentFixture('a', 'needs-you')], 'needs-you')} onAction={onAction} />
    );
    act(() => el('orchestrator-swimlanes-lane-a').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'a' });
    act(() => el('orchestrator-swimlanes-lane-root').click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-root' });
  });

  it('has no root lane while the root is not waiting', async () => {
    await themed.render(
      <Swimlanes snapshot={snapshotFixture([viewAgentFixture('a', 'working')], 'working')} onAction={onAction} />
    );
    expect(query('orchestrator-swimlanes-lane-root')).toBeNull();
  });

  it('says so when there are no agents', async () => {
    await themed.render(<Swimlanes snapshot={snapshotFixture([], 'idle')} onAction={onAction} />);
    expect(el('orchestrator-swimlanes-empty').textContent).toBe('No agents yet');
    expect(laneIds()).toEqual([]);
  });
});
