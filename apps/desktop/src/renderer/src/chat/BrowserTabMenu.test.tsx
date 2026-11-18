// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabSummary } from '@shared/ipc';
import type { BrowserTabUse } from './browserTabClose';
import { BrowserTabStrip } from './BrowserTabStrip';

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

const tabs: BrowserTabSummary[] = [
  { id: 1, title: 'Docs', url: 'https://example.com/docs', loading: false },
  { id: 2, title: 'App', url: 'http://localhost:3000/', loading: false },
  { id: 3, title: 'Search', url: 'https://example.com/search', loading: false },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(inUse: (tab: BrowserTabSummary) => BrowserTabUse | null) {
  const onCloseTabs = vi.fn<(ids: number[]) => void>();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CssVarsProvider>
        <BrowserTabStrip
          tabs={tabs}
          activeTabId={1}
          onSelect={() => undefined}
          onClose={() => undefined}
          onNew={() => undefined}
          inUse={inUse}
          onCloseTabs={onCloseTabs}
        />
      </CssVarsProvider>
    )
  );
  return onCloseTabs;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function rightClick(tabId: number) {
  const target = document.querySelector<HTMLElement>(`[data-testid="browser-tab-select-btn"][data-tab-id="${tabId}"]`);
  act(() => {
    target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
  });
}

function click(testId: string) {
  act(() => {
    byTestId(testId)?.click();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('BrowserTabMenu', () => {
  it('opens on right-click with the four close actions', () => {
    mount(() => null);
    rightClick(2);
    expect(byTestId('browser-tab-menu')).not.toBeNull();
    expect(byTestId('browser-tab-menu-close-btn')?.textContent).toBe('Close tab');
    expect(byTestId('browser-tab-menu-close-others-btn')?.textContent).toBe('Close other tabs');
    expect(byTestId('browser-tab-menu-close-right-btn')?.textContent).toBe('Close tabs to the right');
    expect(byTestId('browser-tab-menu-close-all-btn')?.textContent).toBe('Close all tabs');
  });

  it.each([
    { key: 'F10', shiftKey: true },
    { key: 'ContextMenu', shiftKey: false },
  ])('opens from the keyboard with $key', init => {
    mount(() => null);
    const target = document.querySelector<HTMLElement>('[data-testid="browser-tab-select-btn"][data-tab-id="2"]');
    act(() => {
      target?.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
    });
    expect(byTestId('browser-tab-menu')).not.toBeNull();
  });

  it('does not open on F10 without Shift', () => {
    mount(() => null);
    const target = document.querySelector<HTMLElement>('[data-testid="browser-tab-select-btn"][data-tab-id="2"]');
    act(() => {
      target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true, cancelable: true }));
    });
    expect(byTestId('browser-tab-menu')).toBeNull();
  });

  it('closes tabs not in use straight away', () => {
    const onCloseTabs = mount(() => null);
    rightClick(2);
    click('browser-tab-menu-close-others-btn');
    expect(onCloseTabs).toHaveBeenCalledWith([1, 3]);
    expect(byTestId('browser-tab-close-confirm-dialog')).toBeNull();
  });

  it('disables "Close tabs to the right" on the last tab', () => {
    mount(() => null);
    rightClick(3);
    expect(byTestId('browser-tab-menu-close-right-btn')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('names the tabs in use and closes only once confirmed', () => {
    const onCloseTabs = mount(tab => (tab.id === 2 ? 'dev-server' : tab.id === 3 ? 'agent' : null));
    rightClick(1);
    click('browser-tab-menu-close-all-btn');
    expect(onCloseTabs).not.toHaveBeenCalled();

    const dialog = byTestId('browser-tab-close-confirm-dialog');
    expect(dialog?.textContent).toContain('Close 3 tabs?');
    const items = [...document.querySelectorAll('[data-testid="browser-tab-close-confirm-item"]')].map(
      item => item.textContent
    );
    expect(items).toEqual(['App (dev server preview)', 'Search (the agent is using this page)']);

    click('browser-tab-close-confirm-btn');
    expect(onCloseTabs).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('closes nothing when the confirmation is cancelled', () => {
    const onCloseTabs = mount(tab => (tab.id === 2 ? 'dev-server' : null));
    rightClick(1);
    click('browser-tab-menu-close-right-btn');
    expect(byTestId('browser-tab-close-confirm-dialog')?.textContent).toContain('Close 2 tabs?');
    click('browser-tab-close-cancel-btn');
    expect(onCloseTabs).not.toHaveBeenCalled();
    expect(byTestId('browser-tab-close-confirm-dialog')).toBeNull();
  });
});
