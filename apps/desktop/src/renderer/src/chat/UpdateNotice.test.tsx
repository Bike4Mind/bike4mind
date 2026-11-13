// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import {
  initialUpdateState,
  reduceUpdate,
  type UpdateBusyReport,
  type UpdateInstallResult,
  type UpdateState,
} from '@shared/update';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateNotice, UpdateNotice, type UpdateNoticeActions } from './UpdateNotice';
import { useAppUpdate } from './useAppUpdate';

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

const RELEASE = 'https://github.com/acme/desktop-dist/releases/tag/desktop-v0.2.0';
const BUSY: UpdateBusyReport = { replying: 1, awaitingApproval: 0, background: 0 };

function offered(version: string, extra: Partial<UpdateState> = {}): UpdateState {
  return {
    ...reduceUpdate(initialUpdateState('0.1.10', true), { type: 'available', version, at: 1 }),
    releaseUrl: RELEASE,
    ...extra,
  };
}

function actionsFor(extra: Partial<UpdateNoticeActions> = {}): UpdateNoticeActions {
  return {
    blockedBy: null,
    downloadFailed: false,
    download: vi.fn(),
    install: vi.fn(async () => false),
    dismissBlock: vi.fn(),
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

async function render(node: ReactNode) {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<CssVarsProvider>{node}</CssVarsProvider>);
  });
}

function mount(
  state: UpdateState,
  options: {
    onOpenRelease?: (url: string) => void;
    onDismiss?: (v: string) => void;
    actions?: UpdateNoticeActions;
  } = {}
) {
  return render(
    <UpdateNotice
      state={state}
      onOpenRelease={options.onOpenRelease ?? (() => {})}
      onDismiss={options.onDismiss ?? (() => {})}
      actions={options.actions}
    />
  );
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe('UpdateNotice', () => {
  it('announces the newer version and opens its release page', async () => {
    const onOpenRelease = vi.fn();
    await mount(offered('0.2.0'), { onOpenRelease });

    expect(byTestId('update-notice-title')?.textContent).toBe('Bike4Mind 0.2.0 is available');
    act(() => byTestId('update-notice-release-link')?.click());
    expect(onOpenRelease).toHaveBeenCalledWith(RELEASE);
  });

  it('dismisses for the version it shows', async () => {
    const onDismiss = vi.fn();
    await mount(offered('0.2.0'), { onDismiss });

    act(() => byTestId('update-notice-dismiss-btn')?.click());
    expect(onDismiss).toHaveBeenCalledWith('0.2.0');
  });

  it('stays hidden for a dismissed version, and shows again for a later one', async () => {
    await mount(offered('0.2.0', { dismissedVersion: '0.2.0' }));
    expect(byTestId('update-notice')).toBeNull();

    await mount(offered('0.3.0', { dismissedVersion: '0.2.0' }));
    expect(byTestId('update-notice-title')?.textContent).toBe('Bike4Mind 0.3.0 is available');
  });

  it('renders nothing when updates are off, as in pnpm dev', async () => {
    await mount(initialUpdateState('0.1.10', false));
    expect(byTestId('update-notice')).toBeNull();
  });

  it('omits the link when the feed has no known release page', async () => {
    await mount(offered('0.2.0', { releaseUrl: null }));
    expect(byTestId('update-notice')).not.toBeNull();
    expect(byTestId('update-notice-release-link')).toBeNull();
  });

  it('only informs when it is given no update actions', async () => {
    await mount(offered('0.2.0'));
    expect(byTestId('update-notice-release-link')?.textContent).toBe('Release notes and download');
    expect(byTestId('update-notice-download-btn')).toBeNull();
    expect(byTestId('update-notice-install-btn')).toBeNull();
  });
});

describe('UpdateNotice with in-app updates', () => {
  it('starts the download from the offer', async () => {
    const actions = actionsFor();
    await mount(offered('0.2.0'), { actions });

    expect(byTestId('update-notice-release-link')?.textContent).toBe('Release notes');
    act(() => byTestId('update-notice-download-btn')?.click());
    expect(actions.download).toHaveBeenCalledTimes(1);
  });

  it('follows the download with the version and percent, and offers no dismiss while it runs', async () => {
    const downloading = reduceUpdate(reduceUpdate(offered('0.2.0'), { type: 'download-started' }), {
      type: 'progress',
      percent: 40,
    });
    await mount(downloading, { actions: actionsFor() });

    expect(byTestId('update-notice-title')?.textContent).toBe('Downloading Bike4Mind 0.2.0...');
    expect(byTestId('update-notice-percent-text')?.textContent).toBe('40%');
    expect(byTestId('update-notice-progress')?.getAttribute('aria-valuenow')).toBe('40');
    expect(byTestId('update-notice-dismiss-btn')).toBeNull();
    expect(byTestId('update-notice-download-btn')).toBeNull();
  });

  it('asks for a restart once the update is downloaded', async () => {
    const actions = actionsFor();
    await mount(offered('0.2.0', { status: 'ready', percent: 100 }), { actions });

    expect(byTestId('update-notice-title')?.textContent).toBe('Bike4Mind 0.2.0 is ready to install');
    expect(byTestId('update-notice-dismiss-btn')).toBeNull();
    act(() => byTestId('update-notice-install-btn')?.click());
    expect(actions.install).toHaveBeenCalledWith(false);
  });

  it('names the work a restart would end before restarting anyway', async () => {
    const actions = actionsFor({ blockedBy: BUSY });
    await mount(offered('0.2.0', { status: 'ready', percent: 100 }), { actions });

    expect(byTestId('update-notice-install-btn')).toBeNull();
    expect(byTestId('update-busy-alert')?.textContent).toContain('1 session is still working.');
    act(() => byTestId('update-keep-btn')?.click());
    expect(actions.dismissBlock).toHaveBeenCalledTimes(1);
    act(() => byTestId('update-force-install-btn')?.click());
    expect(actions.install).toHaveBeenCalledWith(true);
  });

  it('keeps a started download and a staged update on screen after the offer was dismissed', async () => {
    const declined = offered('0.2.0', { dismissedVersion: '0.2.0' });
    await mount(reduceUpdate(declined, { type: 'download-started' }), { actions: actionsFor() });
    expect(byTestId('update-notice-progress')).not.toBeNull();

    await mount({ ...declined, status: 'ready', percent: 100 }, { actions: actionsFor() });
    expect(byTestId('update-notice-install-btn')).not.toBeNull();
  });

  it('says when a download did not finish and offers it again, even for a dismissed offer', async () => {
    const actions = actionsFor({ downloadFailed: true });
    await mount(offered('0.2.0', { dismissedVersion: '0.2.0' }), { actions });

    expect(byTestId('update-notice-error-text')?.textContent).toBe('The download did not finish.');
    expect(byTestId('update-notice-download-btn')?.textContent).toBe('Try again');
    act(() => byTestId('update-notice-download-btn')?.click());
    expect(actions.download).toHaveBeenCalledTimes(1);
  });

  it('floats in the upper-right corner, below the 53px header bar', async () => {
    await mount(offered('0.2.0'), { actions: actionsFor() });
    const style = getComputedStyle(byTestId('update-notice') as HTMLElement);

    expect(style.position).toBe('fixed');
    expect(style.top).toBe('65px');
    expect(style.right).toBe('12px');
    expect(style.left).toBe('auto');
    expect(style.bottom).toBe('auto');
  });
});

describe('AppUpdateNotice', () => {
  function stubBridge(initial: UpdateState) {
    let push: (state: UpdateState) => void = () => {};
    const bridge = {
      getState: vi.fn(async () => initial),
      onStateChanged: vi.fn((listener: (state: UpdateState) => void) => {
        push = listener;
        return () => {};
      }),
      check: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
      install: vi.fn(async (): Promise<UpdateInstallResult> => ({ ok: false, reason: 'not-ready' })),
    };
    (window as unknown as { b4m: unknown }).b4m = { update: bridge, shell: { openExternal: vi.fn() } };
    return { bridge, push: (state: UpdateState) => push(state) };
  }

  it('surfaces a download that failed, then lets the user close it', async () => {
    const declined = offered('0.2.0', { dismissedVersion: '0.2.0' });
    const { bridge, push } = stubBridge(declined);
    const Wired = () => <AppUpdateNotice controller={useAppUpdate()} />;
    await render(<Wired />);
    expect(byTestId('update-notice')).toBeNull();

    // Both pushes land before React renders, as when a download fails straight away.
    act(() => {
      push(reduceUpdate(declined, { type: 'download-started' }));
      push(declined);
    });
    expect(byTestId('update-notice-error-text')).not.toBeNull();

    act(() => byTestId('update-notice-download-btn')?.click());
    expect(bridge.download).toHaveBeenCalledTimes(1);

    act(() => byTestId('update-notice-dismiss-btn')?.click());
    expect(bridge.dismiss).toHaveBeenCalledWith('0.2.0');
    expect(byTestId('update-notice')).toBeNull();
  });
});
