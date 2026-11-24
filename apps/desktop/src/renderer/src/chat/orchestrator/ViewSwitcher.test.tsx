// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMac } from '../platform';
import { ORCHESTRATOR_VIEWS } from './orchestratorPrefs';
import { singlePaneLayout, type OrchestratorLayout } from './orchestratorLayout';
import { createThemedMount, el, query } from './testUtils';
import { ORCHESTRATOR_VIEW_COMPONENTS } from './viewRegistry';
import {
  ORCHESTRATOR_VIEW_INFO,
  ViewSwitcher,
  RESET_LAYOUT,
  fitMenuToViewport,
  menuMaxHeight,
  isFocusToggle,
  isViewReset,
  stepView,
  viewStepFor,
} from './ViewSwitcher';

const themed = createThemedMount();
const onLayoutChange = vi.fn();

afterEach(() => {
  themed.unmount();
  onLayoutChange.mockReset();
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

describe('isFocusToggle', () => {
  it('matches Mod+Shift+F only', () => {
    expect(isFocusToggle(shortcut('KeyF'))).toBe(true);
    expect(isFocusToggle(shortcut('KeyF', { shiftKey: false }))).toBe(false);
    expect(isFocusToggle(shortcut('KeyF', { altKey: true }))).toBe(false);
    expect(isFocusToggle(shortcut('KeyG'))).toBe(false);
  });
});

describe('isViewReset', () => {
  it('matches Mod+Shift+Esc only', () => {
    expect(isViewReset(shortcut('Escape'))).toBe(true);
    expect(isViewReset(shortcut('Escape', { shiftKey: false }))).toBe(false);
    expect(isViewReset(shortcut('Escape', { altKey: true }))).toBe(false);
    expect(isViewReset(shortcut('Escape', { metaKey: false, ctrlKey: false }))).toBe(false);
    expect(isViewReset(shortcut('KeyO'))).toBe(false);
  });
});

describe('ViewSwitcher', () => {
  it('has a menu entry and a component for every view, and nothing more', () => {
    for (const id of ORCHESTRATOR_VIEWS) {
      expect(ORCHESTRATOR_VIEW_INFO[id].label).toBeTruthy();
      expect(ORCHESTRATOR_VIEW_COMPONENTS[id]).toBeTypeOf('function');
    }
    expect(Object.keys(ORCHESTRATOR_VIEW_INFO).sort()).toEqual([...ORCHESTRATOR_VIEWS].sort());
    expect(Object.keys(ORCHESTRATOR_VIEW_COMPONENTS).sort()).toEqual([...ORCHESTRATOR_VIEWS].sort());
  });

  it('shows the current view on the button, and lists every view under its group with the current one checked', async () => {
    await themed.render(<ViewSwitcher layout={singlePaneLayout('board')} onLayoutChange={onLayoutChange} />);
    const button = el('orchestrator-view-menu-btn');
    expect(button.dataset.view).toBe('board');
    expect(button.textContent).toContain('Board');
    act(() => button.click());
    const menu = el('orchestrator-view-menu');
    expect(menu.textContent).toContain('Scenes');
    expect(menu.textContent).toContain('Layouts');
    for (const id of ORCHESTRATOR_VIEWS) expect(query(`orchestrator-view-option-${id}`)).not.toBeNull();
    // The selected option carries a check after its view icon.
    expect(el('orchestrator-view-option-board').querySelectorAll('svg')).toHaveLength(2);
    expect(el('orchestrator-view-option-table').querySelectorAll('svg')).toHaveLength(1);
  });

  it('offers the Presenter switch, and Reset leaves it on', async () => {
    const onToggle = vi.fn();
    await themed.render(
      <ViewSwitcher layout={singlePaneLayout('tavern')} onLayoutChange={vi.fn()} presenter={{ on: true, onToggle }} />
    );
    act(() => el('orchestrator-view-menu-btn').click());
    const toggle = el('orchestrator-presenter-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    act(() => el('orchestrator-view-reset').click());
    expect(onToggle).not.toHaveBeenCalled();
    act(() => el('orchestrator-view-menu-btn').click());
    act(() => el('orchestrator-presenter-toggle').click());
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('offers the Focus switch on every view and toggles it from the menu and the shortcut', async () => {
    const onToggle = vi.fn();
    await themed.render(
      <ViewSwitcher
        layout={singlePaneLayout('board')}
        onLayoutChange={onLayoutChange}
        focus={{ on: false, onToggle }}
      />
    );
    expect(el('orchestrator-view-menu-btn').dataset.focus).toBe('off');
    act(() => el('orchestrator-view-menu-btn').click());
    const toggle = el('orchestrator-focus-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => toggle.click());
    expect(onToggle).toHaveBeenLastCalledWith(true);

    await themed.render(
      <ViewSwitcher layout={singlePaneLayout('board')} onLayoutChange={onLayoutChange} focus={{ on: true, onToggle }} />
    );
    expect(el('orchestrator-view-menu-btn').textContent).toContain('Focus');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shortcut('KeyF')));
    });
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('takes Mod+Shift+F in the capture phase and marks it handled, so the sidebar search yields to it', async () => {
    const onToggle = vi.fn();
    await themed.render(
      <ViewSwitcher
        layout={singlePaneLayout('board')}
        onLayoutChange={onLayoutChange}
        focus={{ on: false, onToggle }}
      />
    );
    const sawHandled = vi.fn();
    const later = (event: KeyboardEvent) => sawHandled(event.defaultPrevented);
    window.addEventListener('keydown', later);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { ...shortcut('KeyF'), cancelable: true }));
    });
    window.removeEventListener('keydown', later);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(sawHandled).toHaveBeenCalledWith(true);
  });

  it('offers the quiet-when-idle switch only on views that settle, checked while on', async () => {
    const onToggle = vi.fn();
    await themed.render(
      <ViewSwitcher
        layout={singlePaneLayout('board')}
        onLayoutChange={onLayoutChange}
        ambient={{ on: true, onToggle }}
      />
    );
    act(() => el('orchestrator-view-menu-btn').click());
    expect(query('orchestrator-ambient-toggle')).toBeNull();

    themed.unmount();
    await themed.render(
      <ViewSwitcher
        layout={singlePaneLayout('tavern')}
        onLayoutChange={onLayoutChange}
        ambient={{ on: true, onToggle }}
      />
    );
    act(() => el('orchestrator-view-menu-btn').click());
    const toggle = el('orchestrator-ambient-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    act(() => toggle.click());
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('resets to Board and turns Focus off from the shortcut and the menu', async () => {
    const onToggle = vi.fn();
    await themed.render(
      <ViewSwitcher
        layout={singlePaneLayout('tavern')}
        onLayoutChange={onLayoutChange}
        focus={{ on: true, onToggle }}
      />
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shortcut('Escape')));
    });
    expect(onLayoutChange).toHaveBeenLastCalledWith(RESET_LAYOUT);
    expect(RESET_LAYOUT, 'reset is Board alone, whatever the split').toEqual(singlePaneLayout('board'));
    expect(onToggle).toHaveBeenLastCalledWith(false);

    onLayoutChange.mockReset();
    onToggle.mockReset();
    act(() => el('orchestrator-view-menu-btn').click());
    act(() => el('orchestrator-view-reset').click());
    expect(onLayoutChange).toHaveBeenCalledWith(RESET_LAYOUT);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('resets from a focused composer that would otherwise stop the turn', async () => {
    await themed.render(
      <>
        <ViewSwitcher layout={singlePaneLayout('tavern')} onLayoutChange={onLayoutChange} />
        <textarea data-testid="fake-composer" />
      </>
    );
    const onStop = vi.fn();
    // Mirrors the composer's own handler: Escape with a live turn stops it.
    const textarea = el('fake-composer');
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onStop();
      }
    });
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { ...shortcut('Escape'), key: 'Escape', bubbles: true }));
    });
    expect(onLayoutChange).toHaveBeenCalledWith(RESET_LAYOUT);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('leaves Focus alone on reset when it is already off', async () => {
    const onToggle = vi.fn();
    await themed.render(
      <ViewSwitcher
        layout={singlePaneLayout('table')}
        onLayoutChange={onLayoutChange}
        focus={{ on: false, onToggle }}
      />
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shortcut('Escape')));
    });
    expect(onLayoutChange).toHaveBeenCalledWith(singlePaneLayout('board'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('reports the picked view', async () => {
    await themed.render(<ViewSwitcher layout={singlePaneLayout('table')} onLayoutChange={onLayoutChange} />);
    act(() => el('orchestrator-view-menu-btn').click());
    act(() => el('orchestrator-view-option-tavern').click());
    expect(onLayoutChange).toHaveBeenCalledWith(singlePaneLayout('tavern'));
  });

  it('treats Office as an ambient scene', async () => {
    expect(ORCHESTRATOR_VIEW_INFO.office.group).toBe('scene');

    await themed.render(
      <ViewSwitcher
        layout={singlePaneLayout('office')}
        onLayoutChange={onLayoutChange}
        ambient={{ on: true, onToggle: vi.fn() }}
      />
    );
    expect(el('orchestrator-view-menu-btn').textContent).toContain('Office');
    act(() => el('orchestrator-view-menu-btn').click());
    expect(el('orchestrator-ambient-toggle').getAttribute('aria-checked')).toBe('true');
    expect(stepView('aquarium', 1)).toBe('office');
    expect(stepView('office', 1)).toBe('board');
  });

  it('cycles views from the keyboard shortcut', async () => {
    await themed.render(<ViewSwitcher layout={singlePaneLayout('tavern')} onLayoutChange={onLayoutChange} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shortcut('BracketRight')));
    });
    expect(onLayoutChange).toHaveBeenLastCalledWith(singlePaneLayout(stepView('tavern', 1)));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shortcut('BracketLeft')));
    });
    expect(onLayoutChange).toHaveBeenLastCalledWith(singlePaneLayout(stepView('tavern', -1)));
  });

  it('ignores a shortcut another handler already consumed', async () => {
    await themed.render(<ViewSwitcher layout={singlePaneLayout('tavern')} onLayoutChange={onLayoutChange} />);
    const handled = new KeyboardEvent('keydown', { ...shortcut('BracketRight'), cancelable: true });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', async () => {
    await themed.render(<ViewSwitcher layout={singlePaneLayout('tavern')} onLayoutChange={onLayoutChange} />);
    themed.unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', shortcut('BracketRight')));
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  describe('pane layouts', () => {
    const split: OrchestratorLayout = {
      split: 'row',
      panes: [
        { view: 'board', size: 0.5 },
        { view: 'transit', size: 0.5 },
      ],
    };

    it('offers the presets, checking the current one', async () => {
      await themed.render(<ViewSwitcher layout={singlePaneLayout('board')} onLayoutChange={onLayoutChange} />);
      act(() => el('orchestrator-view-menu-btn').click());
      act(() => el('orchestrator-layout-option-side-by-side').click());
      expect(onLayoutChange).toHaveBeenCalledWith(split);
    });

    it('names a split by its preset, gives each pane its own view menu, and stacks the panes it has', async () => {
      await themed.render(<ViewSwitcher layout={split} onLayoutChange={onLayoutChange} />);
      expect(el('orchestrator-view-menu-btn').textContent).toContain('Side by side');
      expect(el('orchestrator-view-menu-btn').dataset.layout).toBe('side-by-side');
      expect(el('orchestrator-pane-view-menu-btn-0').getAttribute('aria-label')).toBe('Pane 1 view: Board');
      expect(el('orchestrator-pane-view-menu-btn-1').getAttribute('aria-label')).toBe('Pane 2 view: Transit');

      act(() => el('orchestrator-view-menu-btn').click());
      expect(query('orchestrator-view-option-tavern')).toBeNull();
      act(() => el('orchestrator-layout-option-stacked').click());
      expect(onLayoutChange).toHaveBeenCalledWith({ ...split, split: 'column' });
    });

    it("changes only the picked pane's view from a bounded pane menu", async () => {
      await themed.render(<ViewSwitcher layout={split} onLayoutChange={onLayoutChange} />);
      act(() => el('orchestrator-pane-view-menu-btn-1').click());
      await act(async () => {});
      expect(el('orchestrator-pane-view-menu-1').style.maxHeight).toMatch(/^\d+px$/);
      act(() => el('orchestrator-pane-1-view-option-constellation').click());
      expect(onLayoutChange).toHaveBeenCalledWith({
        ...split,
        panes: [split.panes[0], { view: 'constellation', size: 0.5 }],
      });
    });

    it('steps the view of the pane holding focus', async () => {
      const pane = document.createElement('div');
      pane.dataset.orchestratorPane = '';
      pane.dataset.paneIndex = '1';
      pane.tabIndex = -1;
      document.body.append(pane);
      try {
        await themed.render(<ViewSwitcher layout={split} onLayoutChange={onLayoutChange} />);
        pane.focus();
        act(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', shortcut('BracketRight')));
        });
        expect(onLayoutChange).toHaveBeenLastCalledWith({
          ...split,
          panes: [split.panes[0], { view: stepView('transit', 1), size: 0.5 }],
        });
      } finally {
        pane.remove();
      }
    });
  });
});

describe('menu height', () => {
  it('fits the space beside the button, keeping a margin and a floor', () => {
    expect(menuMaxHeight(760)).toBe(752);
    expect(menuMaxHeight(760.4)).toBe(752);
    expect(menuMaxHeight(10)).toBe(120);
  });

  type ModifierArgs = Parameters<NonNullable<typeof fitMenuToViewport.fn>>[0];
  const runModifier = (placement: string) => {
    const state = {
      placement,
      elements: { reference: { getBoundingClientRect: () => ({ top: 300, bottom: 330 }) } },
      styles: { popper: { position: 'absolute' } },
    };
    fitMenuToViewport.fn?.({ state } as unknown as ModifierArgs);
    return state.styles.popper;
  };

  it('caps the popper to the window below its anchor', () => {
    expect(runModifier('bottom-start')).toEqual({
      position: 'absolute',
      maxHeight: `${menuMaxHeight(window.innerHeight - 330)}px`,
    });
  });

  it('caps the popper to the window above its anchor when flipped', () => {
    expect(runModifier('top-start')).toEqual({ position: 'absolute', maxHeight: `${menuMaxHeight(300)}px` });
  });

  it('opens the view menu as a bounded, scrollable list', async () => {
    await themed.render(<ViewSwitcher layout={singlePaneLayout('tavern')} onLayoutChange={onLayoutChange} />);
    act(() => el('orchestrator-view-menu-btn').click());
    expect(getComputedStyle(el('orchestrator-view-menu')).overflowY).toBe('auto');
    await act(async () => {});
    expect(el('orchestrator-view-menu').style.maxHeight).toMatch(/^\d+px$/);
  });
});
