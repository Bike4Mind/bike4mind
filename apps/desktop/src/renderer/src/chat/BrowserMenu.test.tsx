// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { CookieImportState } from '@shared/browserCookies';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { BrowserMenu } from './BrowserMenu';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserPaneState } from '@shared/ipc';
import { BrowserNavbar } from './BrowserNavbar';

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

const COOKIES: CookieImportState = { supported: true, unsupported: '', sites: [] };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function openMenu(historyEnabled: boolean | null, onHistory = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (enabled: boolean | null) =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <BrowserMenu state={COOKIES} onState={() => undefined} historyEnabled={enabled} onHistory={onHistory} />
      </CssVarsProvider>
    );
  await act(async () => render(historyEnabled));
  await act(async () => find('chat-browser-menu')?.click());
  return { onHistory, rerender: (enabled: boolean | null) => act(async () => render(enabled)) };
}

describe('the local history row', () => {
  it('is a labelled checkbox item that toggles without closing the menu', async () => {
    const { onHistory, rerender } = await openMenu(false);
    const row = find('chat-browser-history-toggle');
    expect(row?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(row?.getAttribute('aria-checked')).toBe('false');
    expect(row?.textContent).toContain('Local history');
    expect(document.getElementById(row?.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /messages and the pages/
    );
    // The picture of the switch is not a second control.
    expect(row?.querySelector('input')?.tabIndex).toBe(-1);

    await act(async () => row?.click());
    expect(onHistory).toHaveBeenCalledWith(true);
    await rerender(true);
    expect(find('chat-browser-history-toggle')?.getAttribute('aria-checked')).toBe('true');
    expect(find('chat-browser-import-cookies')).not.toBeNull();
  });

  it('answers the keyboard', async () => {
    const { onHistory } = await openMenu(true);
    const row = find('chat-browser-history-toggle');
    await act(async () => {
      row?.focus();
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onHistory).toHaveBeenCalledWith(false);
    expect(find('chat-browser-history-toggle')).not.toBeNull();
  });

  it('answers the space bar', async () => {
    const { onHistory } = await openMenu(true);
    const row = find('chat-browser-history-toggle');
    await act(async () => {
      row?.focus();
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      row?.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    });
    expect(onHistory).toHaveBeenCalledWith(false);
    expect(find('chat-browser-history-toggle')).not.toBeNull();
  });

  it('is absent with no open conversation', async () => {
    await openMenu(null);
    expect(find('chat-browser-import-cookies')).not.toBeNull();
    expect(find('chat-browser-history-toggle')).toBeNull();
  });
});

const PAGE: BrowserPaneState = {
  // Not one of the imported hosts below: the url bar renders its own address, and an overlap
  // would make the "no host names" assertions pass or fail on the wrong element.
  url: 'http://localhost:3000/',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: '',
  tabs: [{ id: 1, title: 'Local', url: 'http://localhost:3000/', loading: false }],
  activeTabId: 1,
};
const NOTHING: CookieImportState = { supported: true, unsupported: '', sites: [] };

const render = (cookies: CookieImportState) =>
  renderToStaticMarkup(
    <BrowserNavbar
      state={PAGE}
      cookies={cookies}
      onNavigate={() => undefined}
      onGo={() => undefined}
      onCookieState={() => undefined}
      historyEnabled={null}
      onHistory={() => undefined}
    />
  );

describe('the standing cookie indicator', () => {
  it('is not drawn when the jar holds nothing of the user', () => {
    expect(render(NOTHING)).not.toContain('chat-browser-cookies-indicator');
  });

  /**
   * The requirement this is here for: while the agent's browser carries the user's own logins,
   * that has to be readable at a glance by someone who was not watching when it started. A
   * toast would not be, which is why this is asserted rather than left to the import's own
   * confirmation.
   */
  it('counts the imported sites rather than naming them, standing, with a clear beside it', () => {
    const html = render({
      supported: true,
      unsupported: '',
      sites: [
        { host: 'shop.example.com', cookies: 4, profile: 'Default' },
        { host: 'forum.example.test', cookies: 2, profile: 'Default' },
      ],
    });

    expect(html).toContain('chat-browser-cookies-indicator');
    expect(html).toContain('Signed in as you on 2 sites from Chrome');
    expect(html).toContain('chat-browser-cookies-indicator-clear');
    // The names stay off the pane: with a whole profile imported they are hundreds of rows,
    // and the chooser folds that list away precisely so the pane does not become it.
    expect(html).not.toContain('shop.example.com');
    expect(html).not.toContain('forum.example.test');
  });

  it('still offers the menu when importing is not available at all', () => {
    const html = render({ supported: false, unsupported: 'Only on macOS.', sites: [] });
    expect(html).toContain('chat-browser-menu');
    expect(html).not.toContain('chat-browser-cookies-indicator');
  });
});
