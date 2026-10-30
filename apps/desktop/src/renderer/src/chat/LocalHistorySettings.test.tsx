// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { LocalHistorySettings } from './LocalHistorySettings';
import { LOCAL_HISTORY_CHANGED } from './localHistory';

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
const clearHistory = vi.fn<() => Promise<{ entries: number }>>();
let root: Root;
let host: HTMLElement;
beforeEach(async () => {
  clearHistory.mockReset();
  Object.assign(window, { b4m: { chat: { clearHistory } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <LocalHistorySettings />
      </CssVarsProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('clears the index and invalidates visible search results after success', async () => {
  clearHistory.mockResolvedValue({ entries: 0 });
  const changed = vi.fn();
  window.addEventListener(LOCAL_HISTORY_CHANGED, changed);
  try {
    await act(async () => host.querySelector<HTMLElement>('[data-testid="settings-clear-history-btn"]')?.click());
    expect(clearHistory).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('cleared');
  } finally {
    window.removeEventListener(LOCAL_HISTORY_CHANGED, changed);
  }
});

it('shows failure and lets the user retry', async () => {
  clearHistory.mockRejectedValueOnce(new Error('Database unavailable')).mockResolvedValueOnce({ entries: 0 });
  await act(async () => host.querySelector<HTMLElement>('[data-testid="settings-clear-history-btn"]')?.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Database unavailable');
  await act(async () => host.querySelector<HTMLElement>('[data-testid="settings-clear-history-btn"]')?.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(clearHistory).toHaveBeenCalledTimes(2);
});
