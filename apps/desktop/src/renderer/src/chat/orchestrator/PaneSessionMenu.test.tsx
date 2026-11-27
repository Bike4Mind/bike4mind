// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorLayout } from './orchestratorLayout';
import { sessionFixture } from './sessionFixture';
import { createThemedMount, el, query } from './testUtils';
import { ViewSwitcher } from './ViewSwitcher';

const themed = createThemedMount();
const onLayoutChange = vi.fn();

afterEach(() => {
  themed.unmount();
  onLayoutChange.mockReset();
});

const SESSIONS = [
  sessionFixture('grand', undefined, { orchestrate: true, title: 'Grand plan' }),
  sessionFixture('active', 'grand'),
  sessionFixture('kid', 'active', { title: 'Kid task' }),
  sessionFixture('other', undefined, { orchestrate: true, title: 'Other run' }),
];

const split = (sessionId?: string): OrchestratorLayout => ({
  split: 'row',
  panes: [
    { view: 'board', size: 0.5 },
    { view: 'transit', size: 0.5, ...(sessionId && { sessionId }) },
  ],
});

const renderSwitcher = (layout: OrchestratorLayout, presenting = false) =>
  themed.render(
    <ViewSwitcher
      layout={layout}
      onLayoutChange={onLayoutChange}
      paneSessions={{ activeId: 'active', sessions: SESSIONS, presenting }}
    />
  );

describe('PaneSessionMenu', () => {
  it('offers following the active session, the parent, the children and other orchestrations', async () => {
    await renderSwitcher(split());
    expect(el('orchestrator-pane-session-menu-btn-1').textContent).toBe('Active session');
    act(() => el('orchestrator-pane-session-menu-btn-1').click());
    const menu = el('orchestrator-pane-session-menu-1');
    expect(el('orchestrator-pane-1-session-option-active').textContent).toContain('Follow active session');
    expect(el('orchestrator-pane-1-session-option-grand').textContent).toBe('Parent: Grand plan');
    expect(el('orchestrator-pane-1-session-option-kid').textContent).toBe('Child: Kid task');
    expect(el('orchestrator-pane-1-session-option-other').textContent).toBe('Other run');
    expect(query('orchestrator-pane-1-session-option-active-session')).toBeNull();
    expect(menu.textContent).not.toContain('Title active');
  });

  it('pins the pane to a picked session', async () => {
    await renderSwitcher(split());
    act(() => el('orchestrator-pane-session-menu-btn-1').click());
    act(() => el('orchestrator-pane-1-session-option-kid').click());
    expect(onLayoutChange).toHaveBeenLastCalledWith(split('kid'));
  });

  it('shows the pin on the button, and "Follow active session" clears it', async () => {
    await renderSwitcher(split('grand'));
    const button = el('orchestrator-pane-session-menu-btn-1');
    expect(button.textContent).toBe('Parent: Grand plan');
    expect(button.dataset.pinned).toBe('true');
    act(() => button.click());
    act(() => el('orchestrator-pane-1-session-option-active').click());
    const cleared = onLayoutChange.mock.lastCall?.[0] as OrchestratorLayout;
    expect(cleared).toEqual(split());
    expect(cleared.panes[1]).not.toHaveProperty('sessionId');
  });

  it('treats a pin to a session no longer listed as following the active session', async () => {
    await renderSwitcher(split('deleted'));
    expect(el('orchestrator-pane-session-menu-btn-1').textContent).toBe('Active session');
    expect(el('orchestrator-pane-session-menu-btn-1').dataset.pinned).toBeUndefined();
  });

  it('hides titles in Presenter mode', async () => {
    await renderSwitcher(split('kid'), true);
    expect(el('orchestrator-pane-session-menu-btn-1').textContent).toBe('Child session 1');
    act(() => el('orchestrator-pane-session-menu-btn-1').click());
    expect(el('orchestrator-pane-session-menu-1').textContent).not.toMatch(/Grand plan|Kid task|Other run/);
  });

  it('is not offered on a single pane or without session choices', async () => {
    await renderSwitcher({ split: 'row', panes: [{ view: 'board', size: 1 }] });
    expect(query('orchestrator-pane-session-menu-btn-0')).toBeNull();
    await themed.render(<ViewSwitcher layout={split()} onLayoutChange={onLayoutChange} />);
    expect(query('orchestrator-pane-session-menu-btn-0')).toBeNull();
    expect(el('orchestrator-pane-view-menu-btn-1')).toBeTruthy();
  });
});
