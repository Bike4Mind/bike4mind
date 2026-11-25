// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabSummary } from '@shared/ipc';
import type { BrowserTabUse } from './browserTabClose';
import { BrowserTabStrip, browserTabLabel } from './BrowserTabStrip';
import { browserTabUse, closeOrder, tabsToClose } from './browserTabClose';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_BROWSER_TABS } from '@shared/browserTabs';

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

// Joy's popups (menus, selects, tooltips, modals) read every ancestor's computed style on each update,
// and jsdom resolves that against every emotion sheet with no layout to find; the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

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

const tab = (id: number, url = '', agentUsedAt = 0): BrowserTabSummary => ({
  id,
  title: `Tab ${id}`,
  url,
  loading: false,
  agentUsedAt,
});

const strip = [tab(1), tab(2), tab(3), tab(4)];
const ids = (tabs: BrowserTabSummary[]) => tabs.map(entry => entry.id);

describe('tabsToClose', () => {
  it('closes the tab, the others, the ones to its right, or all of them', () => {
    expect(ids(tabsToClose(strip, 2, 'this'))).toEqual([2]);
    expect(ids(tabsToClose(strip, 2, 'others'))).toEqual([1, 3, 4]);
    expect(ids(tabsToClose(strip, 2, 'right'))).toEqual([3, 4]);
    expect(ids(tabsToClose(strip, 2, 'all'))).toEqual([1, 2, 3, 4]);
  });

  it('has nothing to the right of the last tab, nothing other than a lone tab, and nothing for a gone one', () => {
    expect(tabsToClose(strip, 4, 'right')).toEqual([]);
    expect(tabsToClose([tab(1)], 1, 'others')).toEqual([]);
    expect(tabsToClose(strip, 9, 'all')).toEqual([]);
  });
});

describe('browserTabUse', () => {
  it('counts a local dev server page as in use, and a public site as not', () => {
    expect(browserTabUse(tab(1, 'http://localhost:3000/'), null)).toBe('dev-server');
    expect(browserTabUse(tab(1, 'http://app.test/login'), null)).toBe('dev-server');
    expect(browserTabUse(tab(1, 'https://example.com/'), null)).toBeNull();
    expect(browserTabUse(tab(1, ''), null)).toBeNull();
  });

  it('counts a tab the agent used during the running reply, and not one from an earlier reply', () => {
    expect(browserTabUse(tab(1, 'https://example.com/', 2_000), 1_000)).toBe('agent');
    expect(browserTabUse(tab(1, 'https://example.com/', 500), 1_000)).toBeNull();
    expect(browserTabUse(tab(1, 'https://example.com/', 2_000), null)).toBeNull();
  });

  it('counts any tab the agent ever used when the running reply began before this window saw it', () => {
    expect(browserTabUse(tab(1, 'https://example.com/', 1), 0)).toBe('agent');
    expect(browserTabUse(tab(1, 'https://example.com/', 0), 0)).toBeNull();
  });

  it('names the agent over the dev server when both hold', () => {
    expect(browserTabUse(tab(1, 'http://localhost:3000/', 2_000), 1_000)).toBe('agent');
  });
});

describe('closeOrder', () => {
  it('closes the active tab last', () => {
    expect(closeOrder([1, 2, 3], 2)).toEqual([1, 3, 2]);
    expect(closeOrder([1, 3], 2)).toEqual([1, 3]);
    expect(closeOrder([1, 3], null)).toEqual([1, 3]);
  });
});

const stripTab = (id: number, title: string, url: string, loading = false): BrowserTabSummary => ({
  id,
  title,
  url,
  loading,
});

const render = (tabs: BrowserTabSummary[], activeTabId: number | null) =>
  renderToStaticMarkup(
    <CssVarsProvider>
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={() => undefined}
        onClose={() => undefined}
        onNew={() => undefined}
        inUse={() => null}
        onCloseTabs={() => undefined}
      />
    </CssVarsProvider>
  );

describe('browserTabLabel', () => {
  it('prefers the title, then the host while it has none, then "New tab"', () => {
    expect(browserTabLabel(stripTab(1, 'Docs', 'https://example.com/docs'))).toBe('Docs');
    expect(browserTabLabel(stripTab(1, '', 'https://example.com:8443/docs'))).toBe('example.com:8443');
    expect(browserTabLabel(stripTab(1, '', ''))).toBe('New tab');
  });
});

describe('BrowserTabStrip', () => {
  it('gives every tab a close button and a tooltip naming its title and address', () => {
    const html = render([stripTab(1, 'Docs', 'https://example.com/docs'), stripTab(2, '', '')], 1);
    expect(html.match(/data-testid="browser-tab-close-btn"/g)).toHaveLength(2);
    expect(html).toContain('title="Docs\nhttps://example.com/docs"');
    expect(html).toContain('title="New tab"');
    expect(html).toContain('aria-label="Close Docs"');
  });

  it('disables the plus at the cap and says why', () => {
    const full = Array.from({ length: MAX_BROWSER_TABS }, (_, index) => stripTab(index + 1, `Tab ${index + 1}`, ''));
    const plus = (html: string) => html.match(/<button[^>]*data-testid="browser-tab-new-btn"[^>]*>/)?.[0] ?? '';
    expect(plus(render(full, 1))).toContain('disabled');
    expect(plus(render(full, 1))).toContain(`title="At most ${MAX_BROWSER_TABS} tabs"`);
    expect(plus(render([], null))).not.toContain('disabled');
  });
});
