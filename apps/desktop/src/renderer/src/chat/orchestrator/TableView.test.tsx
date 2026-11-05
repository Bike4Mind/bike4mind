// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentView } from './roster';
import { assignPersonas } from './tavern/agentPersona';
import { TableView } from './TableView';
import { agentFixture, createThemedMount, el } from './testUtils';

const onSelect = vi.fn();
const themed = createThemedMount();

const renderTable = (agents: AgentView[]) =>
  themed.render(
    <TableView
      agents={agents}
      onSelect={onSelect}
      selectedId={null}
      introPlaying={false}
      personas={assignPersonas(agents)}
    />
  );

const rowIds = () =>
  Array.from(document.querySelectorAll('[data-testid^="orchestrator-table-row-"]')).map(row =>
    row.getAttribute('data-testid')?.replace('orchestrator-table-row-', '')
  );

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('TableView', () => {
  const agents = [
    agentFixture('a', 'working', { credits: 5 }),
    agentFixture('b', 'working', { credits: 20 }),
    agentFixture('c', 'working', { credits: 10, pr: { number: 7, state: 'open' } }),
  ];

  it('labels a preparing agent Preparing and a plain working one Working', async () => {
    await renderTable([agentFixture('a', 'working', { preparing: 'worktree' }), agentFixture('b')]);
    expect(el('orchestrator-state-chip-preparing').textContent).toBe('Preparing');
    expect(document.body.textContent).toContain('Creating worktree');
    expect(el('orchestrator-state-chip-working').textContent).toBe('Working');
  });

  it('renders a row per agent in roster order', async () => {
    await renderTable(agents);
    expect(rowIds()).toEqual(['a', 'b', 'c']);
    expect(document.body.textContent).toContain('#7 open');
  });

  it('sorts by cost, priciest first, then reverses', async () => {
    await renderTable(agents);
    act(() => el('orchestrator-table-sort-cost').click());
    expect(rowIds()).toEqual(['b', 'c', 'a']);
    act(() => el('orchestrator-table-sort-cost').click());
    expect(rowIds()).toEqual(['a', 'c', 'b']);
  });

  it('keeps dollar-only and unknown-cost rows after credit-priced ones in either direction', async () => {
    await renderTable([
      agentFixture('dollars', 'working', { usdCost: 9 }),
      agentFixture('cheap', 'working', { credits: 1 }),
      agentFixture('unknown'),
      agentFixture('pricey', 'working', { credits: 500 }),
    ]);
    act(() => el('orchestrator-table-sort-cost').click());
    expect(rowIds()).toEqual(['pricey', 'cheap', 'dollars', 'unknown']);
    act(() => el('orchestrator-table-sort-cost').click());
    expect(rowIds()).toEqual(['cheap', 'pricey', 'dollars', 'unknown']);
  });

  it('calls onSelect with the row id and indents deeper agents', async () => {
    await renderTable([agentFixture('a'), agentFixture('b', 'working', { depth: 3 })]);
    act(() => el('orchestrator-table-row-b').click());
    expect(onSelect).toHaveBeenCalledWith('b');
    const title = el('orchestrator-table-row-b').querySelector('td:nth-child(2) p');
    expect(getComputedStyle(title as Element).paddingLeft).toBe('32px');
  });

  it('selects a row from the keyboard with Enter or Space', async () => {
    await renderTable([agentFixture('a'), agentFixture('b')]);
    const row = el('orchestrator-table-row-b');
    expect(row.tabIndex).toBe(0);
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith('b');
    onSelect.mockClear();
    act(() => {
      el('orchestrator-table-row-a').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith('a');
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows the activity while working and the last snippet otherwise', async () => {
    await renderTable([
      agentFixture('a', 'working', { activity: { kind: 'phase', phase: 'thinking' } }),
      agentFixture('b', 'done', { lastSnippet: 'All shipped' }),
      agentFixture('c', 'idle'),
    ]);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Thinking');
    expect(text).toContain('All shipped');
  });
});
