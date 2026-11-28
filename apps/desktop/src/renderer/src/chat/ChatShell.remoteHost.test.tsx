// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

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

/** Every call into Desktop's own IPC namespaces, by namespace and method, with its arguments. */
const ipcCalls: { namespace: string; method: string; args: unknown[] }[] = [];

function recordingBridge(namespace: string, overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      const fallback = name.startsWith('on') ? () => () => undefined : async () => [];
      const real = name in target ? target[name] : fallback;
      if (typeof real !== 'function') return real;
      return (...args: unknown[]) => {
        ipcCalls.push({ namespace, method: name, args });
        return Reflect.apply(real, undefined, args);
      };
    },
  });
}

let root: Root | null = null;

beforeEach(() => {
  window.localStorage.clear();
  ipcCalls.length = 0;
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
  const namespaces: Record<string, unknown> = {
    host: chatBackedHostBridge({
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
    }),
    getAppInfo: async () => ({ homeDirectory: '/home/test' }),
    chat: recordingBridge('chat', {
      listSessions: async () => [LOCAL],
      getSession: async (id: string) => (id === LOCAL.id ? sessionOf(LOCAL) : null),
      getQueuedMessages: async () => [],
      getSessionStatuses: async () => [],
      listModels: async () => ({ models: [] }),
    }),
    sidebar: recordingBridge('sidebar', { getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
  };
  (window as unknown as { b4m: unknown }).b4m = new Proxy(namespaces, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      if (!(name in target)) target[name] = recordingBridge(name);
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

async function renderShell() {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChatShell />
      </CssVarsProvider>
    )
  );
  await act(async () => undefined);
  await act(async () => undefined);
}

async function open(title: string) {
  const row = rowTitled(title);
  if (!row) throw new Error(`no row ${title}`);
  await act(async () => row.click());
  await act(async () => undefined);
  await act(async () => undefined);
}

/** The controls that act through Desktop's IPC: model and tune settings, approval mode, terminal and browser panes. */
const IPC_CONTROLS = [
  'composer-tune-btn',
  'approval-mode-btn',
  'chat-panes-menu-terminal-item',
  'chat-panes-menu-browser-item',
];

async function openPanesMenu() {
  await act(async () => find('chat-panes-menu-btn')?.click());
  await act(async () => undefined);
}

async function rowMenuItems(title: string): Promise<string[]> {
  const button = document.querySelector<HTMLElement>(`[aria-label="Options for ${title}"]`);
  if (!button) throw new Error(`no menu button on ${title}`);
  await act(async () => button.click());
  await act(async () => undefined);
  const items = ['chat-pin-session-btn', 'chat-download-session-btn'].filter(testId => find(testId) !== null);
  await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  return items;
}

describe('a session on another host in the shell', () => {
  it('lists both hosts in one sidebar', async () => {
    await renderShell();
    expect(rowTitled(LOCAL.title)).toBeDefined();
    expect(rowTitled(REMOTE.title)).toBeDefined();
  });

  it('offers Pin and Download on a local row only', async () => {
    await renderShell();
    expect(await rowMenuItems(LOCAL.title)).toEqual(['chat-pin-session-btn', 'chat-download-session-btn']);
    expect(await rowMenuItems(REMOTE.title)).toEqual([]);
  });

  it('keeps every IPC control for a local session', async () => {
    await renderShell();
    await open(LOCAL.title);
    expect(find('chat-session-title')?.textContent).toBe(LOCAL.title);
    await openPanesMenu();
    expect(IPC_CONTROLS.filter(testId => find(testId) === null)).toEqual([]);
  });

  it('renders no control that calls Desktop IPC, and never sends the session id over it', async () => {
    await renderShell();
    await open(REMOTE.title);
    expect(find('chat-session-title')?.textContent).toBe(REMOTE.title);
    expect(document.body.textContent).toContain('hello');
    await openPanesMenu();
    expect(IPC_CONTROLS.filter(testId => find(testId) !== null)).toEqual([]);

    const withRemoteId = ipcCalls.filter(call => JSON.stringify(call.args).includes(REMOTE.id));
    expect(withRemoteId.map(call => `${call.namespace}.${call.method}`)).toEqual([]);
  });
});
