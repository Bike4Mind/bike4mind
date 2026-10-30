// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { initialUpdateState, reduceUpdate, type UpdateState } from '@shared/update';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateNotice } from './UpdateNotice';

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

function offered(version: string, extra: Partial<UpdateState> = {}): UpdateState {
  return {
    ...reduceUpdate(initialUpdateState('0.1.10', true), { type: 'available', version, at: 1 }),
    releaseUrl: RELEASE,
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

function mount(
  state: UpdateState,
  handlers: { onOpenRelease?: (url: string) => void; onDismiss?: (v: string) => void } = {}
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <UpdateNotice
          state={state}
          onOpenRelease={handlers.onOpenRelease ?? (() => {})}
          onDismiss={handlers.onDismiss ?? (() => {})}
        />
      </CssVarsProvider>
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe('UpdateNotice', () => {
  it('announces the newer version and opens its release page', () => {
    const onOpenRelease = vi.fn();
    mount(offered('0.2.0'), { onOpenRelease });

    expect(byTestId('update-notice-title')?.textContent).toBe('Bike4Mind 0.2.0 is available');
    act(() => byTestId('update-notice-release-link')?.click());
    expect(onOpenRelease).toHaveBeenCalledWith(RELEASE);
  });

  it('dismisses for the version it shows', () => {
    const onDismiss = vi.fn();
    mount(offered('0.2.0'), { onDismiss });

    act(() => byTestId('update-notice-dismiss-btn')?.click());
    expect(onDismiss).toHaveBeenCalledWith('0.2.0');
  });

  it('stays hidden for a dismissed version, and shows again for a later one', () => {
    mount(offered('0.2.0', { dismissedVersion: '0.2.0' }));
    expect(byTestId('update-notice')).toBeNull();

    act(() => root?.unmount());
    host?.remove();
    mount(offered('0.3.0', { dismissedVersion: '0.2.0' }));
    expect(byTestId('update-notice-title')?.textContent).toBe('Bike4Mind 0.3.0 is available');
  });

  it('renders nothing when updates are off, as in pnpm dev', () => {
    mount(initialUpdateState('0.1.10', false));
    expect(byTestId('update-notice')).toBeNull();
  });

  it('omits the link when the feed has no known release page', () => {
    mount(offered('0.2.0', { releaseUrl: null }));
    expect(byTestId('update-notice')).not.toBeNull();
    expect(byTestId('update-notice-release-link')).toBeNull();
  });
});
