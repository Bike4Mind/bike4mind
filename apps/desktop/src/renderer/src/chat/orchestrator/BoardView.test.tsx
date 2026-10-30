// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardView } from './BoardView';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query } from './testUtils';

const onSelect = vi.fn();
const themed = createThemedMount();

const renderBoard = (agents: AgentView[]) =>
  themed.render(<BoardView agents={agents} onSelect={onSelect} selectedId={null} introPlaying={false} />);

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('BoardView', () => {
  it('puts stopped and idle agents in Done with a muted state chip', async () => {
    await renderBoard([agentFixture('a', 'stopped'), agentFixture('b', 'idle'), agentFixture('c', 'done')]);
    const done = el('orchestrator-board-column-done');
    expect(done.contains(el('orchestrator-board-card-a'))).toBe(true);
    expect(done.contains(el('orchestrator-board-card-b'))).toBe(true);
    expect(el('orchestrator-board-card-a').textContent).toContain('Stopped');
    expect(el('orchestrator-board-card-b').textContent).toContain('Idle');
  });

  it('shows a count per column header', async () => {
    await renderBoard([
      agentFixture('a', 'working'),
      agentFixture('b', 'working'),
      agentFixture('c', 'needs-you'),
      agentFixture('d', 'failed'),
    ]);
    expect(el('orchestrator-board-column-working').textContent).toContain('Working');
    expect(el('orchestrator-board-count-working').textContent).toBe('2');
    expect(el('orchestrator-board-count-needs-you').textContent).toBe('1');
    expect(el('orchestrator-board-count-failed').textContent).toBe('1');
    expect(el('orchestrator-board-count-done').textContent).toBe('0');
  });

  it('shows Nothing here in an empty column only', async () => {
    await renderBoard([agentFixture('a', 'working')]);
    expect(el('orchestrator-board-column-failed').textContent).toContain('Nothing here');
    expect(el('orchestrator-board-column-working').textContent).not.toContain('Nothing here');
  });

  it('calls onSelect with the card id', async () => {
    await renderBoard([agentFixture('a', 'working')]);
    await act(async () => el('orchestrator-board-card-a').click());
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows activity for working agents, snippet otherwise, plus cost and PR', async () => {
    await renderBoard([
      agentFixture('a', 'done', { lastSnippet: 'all finished', usdCost: 1.5, pr: { number: 7, state: 'open' } }),
    ]);
    const card = el('orchestrator-board-card-a');
    expect(card.textContent).toContain('all finished');
    expect(card.textContent).toContain('#7');
    expect(card.textContent).toContain('$');
  });

  it('survives a reorder re-render in jsdom (FLIP is a no-op there)', async () => {
    await renderBoard([agentFixture('a', 'working'), agentFixture('b', 'working')]);
    await renderBoard([agentFixture('b', 'working'), agentFixture('a', 'done')]);
    expect(el('orchestrator-board-column-done').contains(el('orchestrator-board-card-a'))).toBe(true);
    expect(query('orchestrator-board')).not.toBeNull();
  });
});
