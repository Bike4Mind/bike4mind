// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '@shared/ipc';
import { RuntimeInfo } from './RuntimeInfo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

const info: AppInfo = {
  appVersion: '0.203.0-dev.gabc123def456.dirty',
  electronVersion: '44.0.0',
  nodeVersion: '24.0.0',
  chromeVersion: '140.0.0',
  homeDirectory: '/home/someone',
};

let root: Root | undefined;
let host: HTMLElement | undefined;

async function renderWith(appInfo: AppInfo): Promise<HTMLElement> {
  (window as unknown as { b4m: unknown }).b4m = { getAppInfo: vi.fn(async () => appInfo) };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider>
        <RuntimeInfo />
      </CssVarsProvider>
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('RuntimeInfo', () => {
  it('shows the version and the basis when the run has one', async () => {
    const view = await renderWith({ ...info, versionBasis: 'newest local tag desktop-v0.203.0 (2026-11-13)' });
    expect(view.querySelector('[data-testid="runtime-info-app-row"]')?.textContent).toContain(info.appVersion);
    expect(view.querySelector('[data-testid="runtime-info-version-basis-row"]')?.textContent).toContain(
      'newest local tag desktop-v0.203.0 (2026-11-13)'
    );
  });

  it('shows no basis row for a packaged build', async () => {
    const view = await renderWith({ ...info, appVersion: '0.203.0' });
    expect(view.querySelector('[data-testid="runtime-info-app-row"]')?.textContent).toContain('0.203.0');
    expect(view.querySelector('[data-testid="runtime-info-version-basis-row"]')).toBeNull();
  });

  it('copies the full version on click, however long it is', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const canary = '0.203.0-canary.20261116045321.083d26f9ca44.dirty';
    const view = await renderWith({ ...info, appVersion: canary });
    const value = view.querySelector<HTMLButtonElement>('[data-testid="runtime-info-app-row-value"]');
    expect(value?.textContent).toBe(canary);

    await act(async () => value?.click());

    expect(writeText).toHaveBeenCalledWith(canary);
    expect(value?.dataset.copyState).toBe('copied');
  });

  it('reports a failed copy instead of swallowing it', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await renderWith(info);
    const value = view.querySelector<HTMLButtonElement>('[data-testid="runtime-info-app-row-value"]');

    await act(async () => value?.click());

    expect(value?.dataset.copyState).toBe('failed');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
