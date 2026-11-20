// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { CookieImportState } from '@shared/browserCookies';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { BrowserMenu } from './BrowserMenu';

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
