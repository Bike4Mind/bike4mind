// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { initialUpdateState, reduceUpdate, type UpdateBusyReport } from '@shared/update';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateSettings } from './UpdateSettings';
import type { AppUpdateController } from './useAppUpdate';

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

const BUSY: UpdateBusyReport = { replying: 2, awaitingApproval: 0, background: 0 };
const ready = reduceUpdate(
  reduceUpdate(reduceUpdate(initialUpdateState('0.1.10', true), { type: 'available', version: '0.2.0', at: 1 }), {
    type: 'download-started',
  }),
  { type: 'downloaded', version: '0.2.0' }
);

function controllerFor(extra: Partial<AppUpdateController> = {}): AppUpdateController {
  return {
    state: ready,
    blockedBy: null,
    downloadFailed: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(async () => false),
    dismissBlock: vi.fn(),
    dismiss: vi.fn(),
    ...extra,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(controller: AppUpdateController) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <UpdateSettings controller={controller} />
      </CssVarsProvider>
    );
  });
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('UpdateSettings', () => {
  it('restarts from a ready update', () => {
    const controller = controllerFor();
    mount(controller);

    act(() => byTestId('update-install-btn')?.click());
    expect(controller.install).toHaveBeenCalledWith(false);
    expect(byTestId('update-busy-alert')).toBeNull();
  });

  it('names the running work, then keeps working or restarts anyway', () => {
    const controller = controllerFor({ blockedBy: BUSY });
    mount(controller);

    expect(byTestId('update-install-btn')).toBeNull();
    expect(byTestId('update-busy-alert')?.textContent).toContain('2 sessions are still working.');
    act(() => byTestId('update-keep-btn')?.click());
    expect(controller.dismissBlock).toHaveBeenCalledTimes(1);
    act(() => byTestId('update-force-install-btn')?.click());
    expect(controller.install).toHaveBeenCalledWith(true);
  });
});
