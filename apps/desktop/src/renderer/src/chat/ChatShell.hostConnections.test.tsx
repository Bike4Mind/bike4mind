// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { chatBackedHostBridge, type ChatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeScreen: () => null, useCustomizeAttention: () => undefined }));
vi.mock('./model3d/modelEngineFrame', async importOriginal => ({
  ...(await importOriginal<typeof import('./model3d/modelEngineFrame')>()),
  ModelEngineFrame: class {
    warm() {
      return this;
    }
    dispose() {}
    async build() {
      return null;
    }
  },
}));

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
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((element: Element, pseudo?: string | null) =>
  element instanceof HTMLTextAreaElement
    ? element.style
    : realGetComputedStyle(element, pseudo)) as typeof getComputedStyle;
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const summary = (id: string, title: string, updatedAt: string): ChatSessionSummary =>
  ({ id, title, mode: 'chat', messageCount: 1, createdAt: updatedAt, updatedAt }) as ChatSessionSummary;

const LOCAL = summary('shell-local', 'On this Mac', '2026-10-02T00:00:00.000Z');
const REMOTE = summary('shell-remote', 'On the devbox', '2026-10-01T00:00:00.000Z');
const sessionOf = (row: ChatSessionSummary): ChatSession =>
  ({
    ...row,
    messages: [
      { id: 'p', role: 'user', content: 'hi', createdAt: row.updatedAt },
      { id: 'r', role: 'assistant', content: 'hello', createdAt: row.updatedAt },
    ],
  }) as unknown as ChatSession;

/** An IPC namespace answering `overrides`, and any other method with an empty result (subscriptions with a no-op unsubscribe). */
const withFallback = (overrides: Record<string, unknown>) =>
  new Proxy(overrides, {
    get: (target, method: string | symbol) => {
      if (typeof method !== 'string') return undefined;
      if (method in target) return target[method];
      return method.startsWith('on') ? () => () => undefined : async () => [];
    },
  });

let root: Root | null = null;
let bridge: ChatBackedHostBridge;

beforeEach(() => {
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
  bridge = chatBackedHostBridge({
    remote: {
      hostId: 'devbox',
      label: 'Devbox',
      sessions: [REMOTE],
      answer: method =>
        method === 'session/get'
          ? { session: sessionOf(REMOTE), cursor: { epoch: 'test', seq: 0 } }
          : method === 'queue/list'
            ? { queued: [] }
            : undefined,
    },
  });
  const namespaces: Record<string, unknown> = {
    host: bridge,
    getAppInfo: async () => ({ homeDirectory: '/home/test' }),
    update: { getState: async () => ({ currentVersion: '1.0.0' }) },
    chat: withFallback({
      listSessions: async () => [LOCAL],
      getSession: async (id: string) => (id === LOCAL.id ? sessionOf(LOCAL) : null),
      getQueuedMessages: async () => [],
      getSessionStatuses: async () => [],
      listModels: async () => ({ models: [] }),
    }),
    sidebar: withFallback({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
  };
  (window as unknown as { b4m: unknown }).b4m = new Proxy(namespaces, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      if (!(name in target)) target[name] = withFallback({});
      return target[name];
    },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const rowTitled = (title: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')].find(row =>
    row.textContent?.includes(title)
  );
const flush = () => act(async () => undefined);

async function openRemoteSession() {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChatShell />
      </CssVarsProvider>
    )
  );
  await flush();
  await flush();
  const row = rowTitled('On the devbox');
  if (!row) throw new Error('no remote row');
  await act(async () => row.click());
  await flush();
  await flush();
}

describe('a session on a host that drops', () => {
  it('shows the host chip and lets the user send while it is connected', async () => {
    await openRemoteSession();
    expect(find('composer-host-chip')?.dataset.hostId).toBe('devbox');
    expect(find('composer-blocked-reason')).toBeNull();
  });

  it('says why sending is off, keeps the draft box, and reconnects from the composer', async () => {
    await openRemoteSession();
    await act(async () => bridge.remote?.setConnected(false));
    await flush();
    expect(find('composer-blocked-reason')?.textContent).toContain('Devbox is not connected');
    await act(async () => find('composer-blocked-action-btn')?.click());
    expect(bridge.management.connects).toEqual(['devbox']);
  });
});

describe('with only this computer', () => {
  it('never shows a host chip or a host block', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')));
    (window as unknown as { b4m: { host: unknown } }).b4m.host = chatBackedHostBridge();
    await act(async () =>
      root?.render(
        <CssVarsProvider theme={desktopTheme}>
          <ChatShell />
        </CssVarsProvider>
      )
    );
    await flush();
    await flush();
    const row = rowTitled('On this Mac');
    await act(async () => row?.click());
    await flush();
    expect(find('composer-host-chip')).toBeNull();
    expect(find('composer-blocked-reason')).toBeNull();
  });
});
