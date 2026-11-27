// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { AuthState } from '@shared/auth';
import { initialUpdateState, reduceUpdate, type UpdateBusyReport, type UpdateInstallResult } from '@shared/update';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { Home } from './Home';
import { writeSessionPanelOpen } from '../chat/sessionPanelState';
import { chatBackedHostBridge, chatStubs } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../chat/CustomizePanel', () => ({ CustomizeScreen: () => null, useCustomizeAttention: () => undefined }));
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

function stubWindow() {
  window.localStorage.clear();
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
    host: chatBackedHostBridge(),
    auth: quietBridge({ getState: async () => signedIn }),
    account: quietBridge({
      getProfile: async () => ({ credits: { balance: null, monthlyAllowance: null }, plan: null, tier: null }),
    }),
    chat: quietBridge({
      defaultsForNewSession: async () => ({ model: 'test-model', approvalMode: 'auto', reasoningEffort: 'default' }),
      listModels: async () => ({ models: [] }),
    }),
    sidebar: quietBridge({ getSections: async () => ({ sections: [], assignments: {} }) }),
    update: quietBridge({ getState: async () => ready, install }),
    // The avatar menu's runtime footer asks once it opens.
    getAppInfo: () => new Promise(() => {}),
  };
  (window as unknown as { b4m: unknown }).b4m = new Proxy(namespaces, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      return name in target ? target[name] : quietBridge({});
    },
  });
}

function stubLoopSession() {
  const session = {
    id: 'with-loop',
    title: 'Loop session',
    mode: 'chat' as const,
    model: 'test-model',
    approvalMode: 'auto' as const,
    reasoningEffort: 'default' as const,
    messageCount: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  window.b4m.chat.listSessions = vi.fn(async () => [session]);
  chatStubs().getSession = vi.fn(async () => ({ ...session, messages: [] }));
  window.b4m.chat.getLoop = vi.fn(async () => ({
    sessionId: session.id,
    prompt: 'Check',
    intervalMs: 30000,
    phase: 'scheduled' as const,
    nextRunAt: null,
  }));
}

// The first mount of Home and of its session view is several times slower than any later one (measured,
// over the per-test budget); paid once here instead of inside whichever test runs first.
beforeAll(async () => {
  stubWindow();
  stubLoopSession();
  await mount();
  await act(async () => byTestId('chat-session-item')?.click());
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

beforeEach(stubWindow);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
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
const expectCornerAnchored = (el: HTMLElement) => {
  const style = getComputedStyle(el);
  expect(style.position).toBe('absolute');
  expect(style.right).toBe('12px');
  expect(style.bottom).toBe('12px');
  expect(el.parentElement).toBe(byTestId('chat-update-notice-region'));
  expect(getComputedStyle(el.parentElement!).position).toBe('relative');
  expect(el.parentElement?.contains(byTestId('chat-composer-region'))).toBe(false);
};

describe('the update card in the signed-in window', () => {
  it('anchors above the composer whether the sidebar is open or collapsed', async () => {
    await mount();
    expect(byTestId('sidebar')).not.toBeNull();
    expect(notices()).toHaveLength(1);
    expectCornerAnchored(notices()[0]);
    expect(byTestId('chat-update-notice-region')?.nextElementSibling).toBe(byTestId('chat-composer-region'));
    expect(byTestId('sidebar')?.contains(notices()[0])).toBe(false);

    await act(async () => byTestId('sidebar-toggle-btn')?.click());
    expect(byTestId('sidebar')).toBeNull();
    expect(byTestId('place-rail')).not.toBeNull();
    expect(notices()).toHaveLength(1);
    expectCornerAnchored(notices()[0]);
  });

  it('stays at the thread bottom-right and below the docked session panel', async () => {
    writeSessionPanelOpen(false);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 1280, 720));
    stubLoopSession();
    await mount();
    await act(async () => byTestId('chat-session-item')?.click());
    expect(byTestId('chat-toggle-session-panel-btn')).not.toBeNull();
    expect(getComputedStyle(notices()[0]).right).toBe('12px');

    await act(async () => byTestId('chat-toggle-session-panel-btn')?.click());
    expect(byTestId('session-panel')?.getAttribute('role')).toBe('complementary');
    expectCornerAnchored(notices()[0]);
    expect(Number(getComputedStyle(notices()[0]).zIndex)).toBeLessThan(desktopTheme.zIndex.table);

    await act(async () => byTestId('chat-toggle-session-panel-btn')?.click());
    expect(byTestId('session-panel')).toBeNull();
    expect(getComputedStyle(notices()[0]).right).toBe('12px');
  });

  it('hides the card behind a narrow modal panel without losing a pending restart confirmation', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 560, 720));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    stubLoopSession();
    await mount();
    await act(async () => byTestId('chat-session-item')?.click());
    await act(async () => byTestId('place-rail-account-btn')?.click());
    await act(async () => byTestId('account-attention-chip')?.querySelector('button')?.click());
    expect(install).toHaveBeenCalledWith(false);
    expect(byTestId('update-busy-alert')?.textContent).toContain('1 session is still working.');

    await act(async () => byTestId('chat-toggle-session-panel-btn')?.click());
    expect(byTestId('session-panel')?.getAttribute('role')).toBe('dialog');
    expect(byTestId('session-panel')?.getAttribute('aria-modal')).toBe('true');
    expect(notices()).toHaveLength(0);

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(byTestId('session-panel')).toBeNull();
    expect(notices()).toHaveLength(1);
    expect(byTestId('update-busy-alert')?.textContent).toContain('1 session is still working.');
    await act(async () => byTestId('update-force-install-btn')?.click());
    expect(install).toHaveBeenLastCalledWith(true);
  });
});
