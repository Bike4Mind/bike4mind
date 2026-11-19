// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@shared/agentState';
import { snapshotFixture, viewAgentFixture, createThemedMount, el, query } from './testUtils';

import { Constellation, layoutConstellation, nodeRadius } from './Constellation';
import { stateLampColor } from './statePalette';

const themed = createThemedMount();
const onAction = vi.fn();
const STATES: readonly AgentState[] = ['needs-you', 'working', 'done', 'failed', 'stopped', 'idle'];

afterEach(() => {
  themed.unmount();
  onAction.mockReset();
});

describe('layoutConstellation', () => {
  const roster = [
    viewAgentFixture('a', 'working'),
    viewAgentFixture('b', 'done'),
    viewAgentFixture('a1', 'working', { parentId: 'a', depth: 2 }),
    viewAgentFixture('a2', 'idle', { parentId: 'a', depth: 2 }),
  ];

  it('gives the same positions for the same roster', () => {
    expect(layoutConstellation(roster)).toEqual(layoutConstellation(roster));
  });

  it('puts children one ring further out than their parent, linked to it', () => {
    const nodes = layoutConstellation(roster);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const distance = (id: string) => Math.hypot((byId.get(id)?.x ?? 0) - 320, (byId.get(id)?.y ?? 0) - 320);
    expect(byId.get('a1')?.parentId).toBe('a');
    expect(distance('a1')).toBeGreaterThan(distance('a'));
    expect(distance('a')).toBeCloseTo(distance('b'));
  });

  it('hangs an agent with an unknown parent from the root and survives a parent cycle', () => {
    const nodes = layoutConstellation([
      viewAgentFixture('orphan', 'working', { parentId: 'gone' }),
      viewAgentFixture('x', 'working', { parentId: 'y', depth: 2 }),
      viewAgentFixture('y', 'working', { parentId: 'x', depth: 2 }),
    ]);
    expect(nodes.find(node => node.id === 'orphan')?.parentId).toBeNull();
    expect(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it('shrinks nodes with depth down to a floor', () => {
    expect(nodeRadius(2)).toBeLessThan(nodeRadius(1));
    expect(nodeRadius(50)).toBeGreaterThanOrEqual(8);
  });
});

describe('Constellation', () => {
  it.each(STATES)('draws a %s agent in its state colour, ringed only when it needs the user', async state => {
    await themed.render(
      <Constellation snapshot={snapshotFixture([viewAgentFixture('a', state)])} onAction={onAction} />
    );
    const node = el('orchestrator-constellation-node-a');
    expect(node.dataset.state).toBe(state);
    expect(node.dataset.color).toBe(stateLampColor(state));
    expect(query('orchestrator-constellation-node-a-ring') !== null).toBe(state === 'needs-you');
  });

  it('links each agent to its parent and opens agents and the root on click', async () => {
    await themed.render(
      <Constellation
        snapshot={snapshotFixture([
          viewAgentFixture('a', 'working'),
          viewAgentFixture('c', 'working', { parentId: 'a', depth: 2 }),
        ])}
        onAction={onAction}
      />
    );
    expect(el('orchestrator-constellation-link-c')).not.toBeNull();
    act(() => el('orchestrator-constellation-node-c').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'c' });
    act(() => el('orchestrator-constellation-root').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-root' });
  });

  it('opens an agent from the keyboard', async () => {
    await themed.render(
      <Constellation snapshot={snapshotFixture([viewAgentFixture('a', 'working')])} onAction={onAction} />
    );
    act(() => {
      el('orchestrator-constellation-node-a').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-agent', agentId: 'a' });
  });

  it('shows only the root and a note when there are no agents', async () => {
    await themed.render(<Constellation snapshot={snapshotFixture([], 'idle')} onAction={onAction} />);
    expect(el('orchestrator-constellation-root').dataset.state).toBe('idle');
    expect(el('orchestrator-constellation-empty').textContent).toBe('No agents yet');
  });

  it('rings the root when it waits on the user', async () => {
    await themed.render(<Constellation snapshot={snapshotFixture([], 'needs-you')} onAction={onAction} />);
    expect(query('orchestrator-constellation-root-ring')).not.toBeNull();
  });
});
