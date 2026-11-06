// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMac } from '../platform';
import { ORCHESTRATOR_VIEWS } from './orchestratorPrefs';
import { createThemedMount, el, query } from './testUtils';
import { ORCHESTRATOR_VIEW_INFO, ViewSwitcher, stepView, viewStepFor } from './ViewSwitcher';

const themed = createThemedMount();
const onViewChange = vi.fn();

afterEach(() => {
  themed.unmount();
  onViewChange.mockReset();
});

const shortcut = (code: string, extra: Partial<KeyboardEventInit> = {}) => ({
  metaKey: isMac,
  ctrlKey: !isMac,
  altKey: false,
  shiftKey: true,
  code,
  ...extra,
});

describe('stepView', () => {
  it('steps forward and back, wrapping at both ends', () => {
    const first = ORCHESTRATOR_VIEWS[0];
    const last = ORCHESTRATOR_VIEWS[ORCHESTRATOR_VIEWS.length - 1];
    expect(stepView(first, 1)).toBe(ORCHESTRATOR_VIEWS[1]);
    expect(stepView(last, 1)).toBe(first);
    expect(stepView(first, -1)).toBe(last);
  });
});

describe('viewStepFor', () => {
  it('maps Mod+Shift+brackets to a step', () => {
    expect(viewStepFor(shortcut('BracketRight'))).toBe(1);
    expect(viewStepFor(shortcut('BracketLeft'))).toBe(-1);
  });

  it('ignores the brackets without the full chord', () => {
    expect(viewStepFor(shortcut('BracketRight', { shiftKey: false }))).toBeNull();
    expect(viewStepFor(shortcut('BracketRight', { altKey: true }))).toBeNull();
    expect(viewStepFor(shortcut('BracketRight', { metaKey: false, ctrlKey: false }))).toBeNull();
    expect(viewStepFor(shortcut('KeyA'))).toBeNull();
  });
});

describe('ViewSwitcher', () => {
  it('has a menu entry for every view', () => {
    for (const id of ORCHESTRATOR_VIEWS) expect(ORCHESTRATOR_VIEW_INFO[id].label).toBeTruthy();
  });

  it('shows the current view on the button', async () => {
    await themed.render(<ViewSwitcher view="board" onViewChange={onViewChange} />);
    const button = el('orchestrator-view-menu-btn');
    expect(button.dataset.view).toBe('board');
    expect(button.textContent).toContain('Board');
  });

  it('lists every view under its group and checks the current one', async () => {
    await themed.render(<ViewSwitcher view="board" onViewChange={onViewChange} />);
    act(() => el('orchestrator-view-menu-btn').click());
    const menu = el('orchestrator-view-menu');
    expect(menu.textContent).toContain('Scenes');
    expect(menu.textContent).toContain('Layouts');
    for (const id of ORCHESTRATOR_VIEWS) expect(query(`orchestrator-view-option-${id}`)).not.toBeNull();
    // The selected option carries a check after its view icon.
    expect(el('orchestrator-view-option-board').querySelectorAll('svg')).toHaveLength(2);
    expect(el('orchestrator-view-option-table').querySelectorAll('svg')).toHaveLength(1);
  });

  it('offers the quiet-when-idle switch in the Tavern only, checked while on', async () => {
    const onToggle = vi.fn();
    await themed.render(<ViewSwitcher view="board" onViewChange={onViewChange} ambient={{ on: true, onToggle }} />);
    act(() => el('orchestrator-view-menu-btn').click());
    expect(query('orchestrator-ambient-toggle')).toBeNull();

    themed.unmount();
    await themed.render(<ViewSwitcher view="tavern" onViewChange={onViewChange} ambient={{ on: true, onToggle }} />);
    act(() => el('orchestrator-view-menu-btn').click());
    const toggle = el('orchestrator-ambient-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    act(() => toggle.click());
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('reports the picked view', async () => {
    await themed.render(<ViewSwitcher view="table" onViewChange={onViewChange} />);
    act(() => el('orchestrator-view-menu-btn').click());
    act(() => el('orchestrator-view-option-tavern').click());
    expect(onViewChange).toHaveBeenCalledWith('tavern');
  });

  it('cycles views from the keyboard shortcut', async () => {
    await themed.render(<ViewSwitcher view="tavern" onViewChange={onViewChange} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shortcut('BracketRight')));
    });
    expect(onViewChange).toHaveBeenLastCalledWith(stepView('tavern', 1));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shortcut('BracketLeft')));
    });
    expect(onViewChange).toHaveBeenLastCalledWith(stepView('tavern', -1));
  });

  it('ignores a shortcut another handler already consumed', async () => {
    await themed.render(<ViewSwitcher view="tavern" onViewChange={onViewChange} />);
    const handled = new KeyboardEvent('keydown', { ...shortcut('BracketRight'), cancelable: true });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', async () => {
    await themed.render(<ViewSwitcher view="tavern" onViewChange={onViewChange} />);
    themed.unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', shortcut('BracketRight')));
    expect(onViewChange).not.toHaveBeenCalled();
  });
});
