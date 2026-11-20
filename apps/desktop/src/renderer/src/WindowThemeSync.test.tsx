// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CssVarsProvider, useColorScheme } from '@mui/joy/styles';
import { afterEach, expect, it, vi } from 'vitest';
import { desktopTheme } from './theme';
import { WindowThemeSync } from './WindowThemeSync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem('window-theme-test');
  vi.restoreAllMocks();
});

function ToggleTheme() {
  const { setMode } = useColorScheme();
  return (
    <>
      <button data-testid="window-theme-dark-btn" onClick={() => setMode('dark')}>
        Dark
      </button>
      <button data-testid="window-theme-light-btn" onClick={() => setMode('light')}>
        Light
      </button>
    </>
  );
}

it('syncs the resolved system theme and subsequent app theme changes', async () => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addListener: () => {},
    removeListener: () => {},
  }));
  const setTheme = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('b4m', { setTheme });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme} defaultMode="system" modeStorageKey="window-theme-test">
          <WindowThemeSync />
          <ToggleTheme />
        </CssVarsProvider>
      )
    );
    expect(setTheme).toHaveBeenLastCalledWith('system', '#FBFCFE');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="window-theme-dark-btn"]')!.click());
    expect(setTheme).toHaveBeenLastCalledWith('dark', desktopTheme.colorSchemes.dark.palette.background.surface);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="window-theme-light-btn"]')!.click());
    expect(setTheme).toHaveBeenLastCalledWith('light', '#FBFCFE');
    for (const [, color] of setTheme.mock.calls) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('reports a failed native theme update without rejecting the renderer effect', async () => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addListener: () => {},
    removeListener: () => {},
  }));
  const failure = new Error('native update failed');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('b4m', { setTheme: vi.fn().mockRejectedValue(failure) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme} defaultMode="system" modeStorageKey="window-theme-test">
          <WindowThemeSync />
        </CssVarsProvider>
      )
    );
    expect(warning).toHaveBeenCalledWith('Could not sync native window theme:', failure);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
