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

const renderStage = (agents: AgentView[], dockControl?: ReactNode) =>
  themed.render(
    <OrchestratorStage
      agents={agents}
      view="table"
      onViewChange={onViewChange}
      actions={actions}
      introPlaying={false}
      dockControl={dockControl}
    />
  );

const pressEscape = (init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...init }));
  });

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = { chat: { getSession: vi.fn().mockResolvedValue(null) } };
});

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('OrchestratorStage', () => {
  it('summarises the roster, with ~ when a cost is unknown', async () => {
    await renderStage(FIXTURE);
    expect(query('orchestrator-summary-strip')?.textContent).toBe(
      '4 agents \u00B7 2 working \u00B7 1 need you \u00B7 1 done \u00B7 0 failed \u00B7 ~$3.00'
    );
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
});
