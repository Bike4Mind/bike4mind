// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { inPaneOrder, OpenPaneButtons, PanesMenu, type PaneControl } from './PanesMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const get = (testId: string) => {
  const found = find(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

const pane = (id: PaneControl['id'], overrides: Partial<PaneControl> = {}): PaneControl => ({
  id,
  open: false,
  onToggle: vi.fn(),
  ...overrides,
});

async function mount(panes: PaneControl[], historyOn = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <OpenPaneButtons panes={panes} />
        <PanesMenu panes={panes} historyOn={historyOn} />
      </CssVarsProvider>
    );
  });
}

const openMenu = () => act(async () => get('chat-panes-menu-btn').click());

describe('PanesMenu', () => {
  it('lists the panes in fixed order with the terminal shortcut, and marks the open ones', async () => {
    await mount([pane('model'), pane('browser', { open: true }), pane('terminal'), pane('simulator')]);
    await openMenu();
    const items = [...get('chat-panes-menu').querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
    expect(items.map(item => item.dataset.testid)).toEqual([
      'chat-panes-menu-terminal-item',
      'chat-panes-menu-browser-item',
      'chat-panes-menu-simulator-item',
      'chat-panes-menu-model-item',
    ]);
    expect(items.map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    expect(items[0].textContent).toContain('Ctrl+`');
    // Only the terminal has a bound shortcut.
    expect(items.slice(1).some(item => item.textContent?.includes('Ctrl'))).toBe(false);
  });

  it('toggles a pane from its row', async () => {
    const browser = pane('browser');
    await mount([pane('terminal'), browser]);
    await openMenu();
    await act(async () => get('chat-panes-menu-browser-item').click());
    expect(browser.onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows an unavailable pane disabled, with the reason', async () => {
    const terminal = pane('terminal', { unavailableReason: 'Open a conversation to use the terminal.' });
    await mount([terminal]);
    await openMenu();
    const row = get('chat-panes-menu-terminal-item');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('Open a conversation to use the terminal.');
    await act(async () => row.click());
    expect(terminal.onToggle).not.toHaveBeenCalled();
  });

  it('carries the local history status as a line, not an action, only while it is on', async () => {
    await mount([pane('terminal')], true);
    expect(find('chat-history-indicator')).toBeNull();
    await openMenu();
    const status = get('chat-history-indicator');
    expect(status.textContent).toContain('Local history is on');
    expect(status.getAttribute('role')).toBe('note');
    expect(status.closest('[role^="menuitem"]')).toBeNull();
  });

  it('has no history line while history is off', async () => {
    await mount([pane('terminal')]);
    await openMenu();
    expect(find('chat-history-indicator')).toBeNull();
  });
});

describe('OpenPaneButtons', () => {
  it('promotes only the open panes, in fixed order, as one-click closes', async () => {
    const terminal = pane('terminal', { open: true });
    await mount([pane('model', { open: true }), pane('browser'), pane('simulator', { open: true }), terminal]);
    const buttons = [...host!.querySelectorAll<HTMLElement>('[data-testid^="chat-toggle-"]')];
    expect(buttons.map(button => button.dataset.testid)).toEqual([
      'chat-toggle-terminal-btn',
      'chat-toggle-simulator-btn',
      'chat-toggle-model-btn',
    ]);
    expect(buttons.every(button => button.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(buttons[0].getAttribute('aria-label')).toBe('Hide the terminal');
    await act(async () => buttons[0].click());
    expect(terminal.onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('inPaneOrder', () => {
  it('sorts by the header order, not the given one', () => {
    expect(inPaneOrder([{ id: 'model' }, { id: 'terminal' }, { id: 'browser' }]).map(entry => entry.id)).toEqual([
      'terminal',
      'browser',
      'model',
    ]);
  });
});
