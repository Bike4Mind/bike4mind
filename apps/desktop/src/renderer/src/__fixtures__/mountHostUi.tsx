import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { vi } from 'vitest';
import { desktopTheme } from '../theme';
import type { ChatBackedHostBridge } from './chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
// Joy's popups read every ancestor's computed style on each update; jsdom has no layout to find, so the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

export const DESKTOP_VERSION = '2.0.0';

export type MountedHostUi = {
  openExternal: ReturnType<typeof vi.fn>;
  pickProjectDirectory: ReturnType<typeof vi.fn>;
  unmount: () => Promise<void>;
};

/** Mounts `ui` in the Joy theme against a faked `window.b4m` whose host bridge is `bridge`. */
export async function mountHostUi(ui: ReactNode, bridge: ChatBackedHostBridge): Promise<MountedHostUi> {
  const openExternal = vi.fn(async () => undefined);
  const pickProjectDirectory = vi.fn(async (): Promise<string | null> => null);
  Object.assign(window, {
    b4m: {
      host: bridge,
      update: { getState: async () => ({ currentVersion: DESKTOP_VERSION }) },
      shell: { openExternal },
      chat: { pickProjectDirectory },
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<CssVarsProvider theme={desktopTheme}>{ui}</CssVarsProvider>);
  });
  return {
    openExternal,
    pickProjectDirectory,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export const byTestId = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

export const allByTestId = (testId: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));

export const textOf = (testId: string): string => byTestId(testId)?.textContent ?? '';

export async function click(testId: string): Promise<void> {
  const element = byTestId(testId);
  if (!element) throw new Error(`No element with data-testid ${testId}`);
  await act(async () => element.click());
}

/** Lets pending promises and the effects they schedule settle. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
