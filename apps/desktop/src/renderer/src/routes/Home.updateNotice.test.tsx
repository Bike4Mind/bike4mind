// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { AuthState } from '@shared/auth';
import { initialUpdateState, reduceUpdate, type UpdateBusyReport, type UpdateInstallResult } from '@shared/update';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { Home } from './Home';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../chat/CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));
vi.mock('../chat/Composer', () => ({ Composer: () => null }));

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

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const signedIn: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', label: 'Production', url: 'https://example.invalid' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'u1', nickname: 'Jude' },
};

const BUSY: UpdateBusyReport = { replying: 1, awaitingApproval: 0, background: 0 };
const ready = reduceUpdate(
  reduceUpdate(reduceUpdate(initialUpdateState('0.1.10', true), { type: 'available', version: '0.2.0', at: 1 }), {
    type: 'download-started',
  }),
  { type: 'downloaded', version: '0.2.0' }
);

function quietBridge(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      if (name.startsWith('on')) return () => () => undefined;
      return async () => [];
    },
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let install = vi.fn<(force: boolean) => Promise<UpdateInstallResult>>();

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  install = vi.fn(async (force: boolean) => (force ? { ok: true } : { ok: false, reason: 'busy', busy: BUSY }));
  const namespaces: Record<string, unknown> = {
    auth: quietBridge({ getState: async () => signedIn }),
    chat: quietBridge({
      defaultsForNewSession: async () => ({ model: 'test-model', approvalMode: 'auto', reasoningEffort: 'default' }),
      listModels: async () => ({ models: [] }),
    }),
    sidebar: quietBridge({ getSections: async () => ({ sections: [], assignments: {} }) }),
    update: quietBridge({ getState: async () => ready, install }),
  };
  (window as unknown as { b4m: unknown }).b4m = new Proxy(namespaces, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      return name in target ? target[name] : quietBridge({});
    },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <Home />
      </CssVarsProvider>
    );
  });
  await act(async () => undefined);
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const notices = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="update-notice"]'));

describe('the update card in the signed-in window', () => {
  it('floats once, outside the sidebar, whether the sidebar is open or collapsed', async () => {
    await mount();
    expect(byTestId('sidebar')).not.toBeNull();
    expect(notices()).toHaveLength(1);
    expect(getComputedStyle(notices()[0]).position).toBe('fixed');
    expect(byTestId('sidebar')?.contains(notices()[0])).toBe(false);

    await act(async () => byTestId('sidebar-toggle-btn')?.click());
    expect(byTestId('sidebar-rail')).not.toBeNull();
    expect(notices()).toHaveLength(1);
    expect(getComputedStyle(notices()[0]).position).toBe('fixed');
  });

  it('confirms in the card a restart the account label asked for while work is running', async () => {
    await mount();

    await act(async () => byTestId('account-attention-chip')?.querySelector('button')?.click());
    expect(install).toHaveBeenCalledWith(false);
    expect(notices()[0].querySelector('[data-testid="update-busy-alert"]')?.textContent).toContain(
      '1 session is still working.'
    );

    await act(async () => byTestId('update-force-install-btn')?.click());
    expect(install).toHaveBeenLastCalledWith(true);
  });
});
