// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { AuthState } from '@shared/auth';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeScreen: () => null, useCustomizeAttention: () => undefined }));
// The 3D engine's iframe would make jsdom boot a whole extra window on every mount.
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
// The panel's own behaviour is TerminalPanel.test.tsx's; here it only has to say whose it is.
vi.mock('./TerminalPanel', () => ({
  TerminalPanel: ({ sessionId }: { sessionId: string }) => <div data-testid="terminal-panel">{sessionId}</div>,
}));

// The menu row itself is BrowserMenu.test.tsx's; here the pane only reports what it was handed.
vi.mock('./BrowserPane', () => ({
  BrowserPane: ({
    historyEnabled,
    onHistory,
  }: {
    historyEnabled: boolean | null;
    onHistory: (on: boolean) => void;
  }) => (
    <button
      data-testid="browser-pane-history"
      data-enabled={String(historyEnabled)}
      onClick={() => onHistory(!historyEnabled)}
    />
  ),
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

// Joy's autosizing textarea measures itself on every render, and jsdom resolves that against every
// emotion sheet in the document and every ancestor, with no layout to measure in the end.
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

const session = (id: string, title: string): ChatSessionSummary =>
  ({
    id,
    title,
    mode: 'chat',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }) as ChatSessionSummary;

const SESSIONS = [session('first', 'First'), { ...session('second', 'Second'), mode: 'code' as const }];
let model = 'local:ollama:qwen3:8b';
const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'reply' }));
const getSession = vi.fn<(id: string) => Promise<ChatSession | null>>();
const setSessionHistory = vi.fn(async (id: string, enabled: boolean) => ({
  ...SESSIONS.find(entry => entry.id === id),
  historyEnabled: enabled,
}));
const expiredAuth: AuthState = {
  status: 'signed-out',
  busy: 'idle',
  storage: 'available',
  hostedAvailable: true,
  reauthRequired: true,
  environment: { preset: 'hosted', url: 'https://example.com', label: 'Hosted' },
};

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

beforeEach(() => {
  window.localStorage.clear();
  model = 'local:ollama:qwen3:8b';
  sendMessage.mockClear();
  setSessionHistory.mockClear();
  getSession.mockReset();
  getSession.mockImplementation(
    async id => ({ ...SESSIONS.find(entry => entry.id === id), model, messages: [] }) as unknown as ChatSession
  );
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
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      host: chatBackedHostBridge(),
      getAppInfo: async () => ({ homeDirectory: '/home/test' }),
      chat: quietBridge({
        listSessions: async () => SESSIONS,
        getSession,
        sendMessage,
        setSessionHistory,
        searchHistory: async () => [
          {
            id: 'history-second',
            sessionId: 'second',
            kind: 'session',
            title: 'Code content match',
            snippet: 'needle',
            capturedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
      }),
      // An empty list is not a sections state; the sidebar groups by this one.
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
    },
    {
      get(target, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        return name in target ? target[name as 'chat' | 'sidebar'] : quietBridge({});
      },
    }
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

/** Types into the sidebar search and waits out its history-search debounce. */
async function searchHistory(needle: string) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await act(async () => typeInto('chat-search-input', needle));
  await act(async () => vi.advanceTimersByTimeAsync(150));
  vi.useRealTimers();
}

const openBrowser = async () => {
  await act(async () => el('chat-panes-menu-btn').click());
  await act(async () => el('chat-panes-menu-browser-item').click());
};

/** The history status lives in the Panes menu, so it is only in the DOM while the menu is open. */
const openPanesMenu = () => act(async () => el('chat-panes-menu-btn').click());

async function renderShell(auth?: AuthState) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChatShell auth={auth} />
      </CssVarsProvider>
    );
  });
  await act(async () => undefined);
  await act(async () => el('chat-session-item').click());
  await act(async () => undefined);
}

function typeInto(testId: string, value: string) {
  const input = el(testId);
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('local model and history reachability', () => {
  it.each([true, false])(
    'allows an offline local prompt while keeping hosted expiry blocked (local: %s)',
    async local => {
      model = local ? 'local:ollama:qwen3:8b' : 'claude-sonnet';
      await renderShell(expiredAuth);
      await act(async () => typeInto('chat-composer-input', 'Private question'));
      const send = el('chat-send-btn') as HTMLButtonElement;
      expect(send.disabled).toBe(!local);
      await act(async () => send.click());
      if (local) expect(sendMessage).toHaveBeenCalledWith({ sessionId: 'first', text: 'Private question' });
      else expect(sendMessage).not.toHaveBeenCalled();
    }
  );

  it('keeps the consent switch out of the header and hands it to the browser pane', async () => {
    await renderShell();
    expect(document.querySelector('[data-testid="chat-history-switch"]')).toBeNull();
    // The Panes menu shows a history status only while history is on.
    await openPanesMenu();
    expect(document.querySelector('[data-testid="chat-history-indicator"]')).toBeNull();
    await act(async () => el('chat-panes-menu-btn').click());
    await openBrowser();
    expect(el('browser-pane-history').dataset.enabled).toBe('false');
    await act(async () => el('browser-pane-history').click());
    expect(setSessionHistory).toHaveBeenCalledWith('first', true);
    expect(el('browser-pane-history').dataset.enabled).toBe('true');
  });

  it('opens a Code history result from Chat mode, hiding the previous consent switch until it has loaded', async () => {
    await renderShell();
    expect(el('chat-session-title').textContent).toBe('First');
    // Web conversations stay out of the primary Chat and Code navigation.
    expect(document.querySelector('[data-testid="handoff-server-conversations-btn"]')).toBeNull();
    expect(host?.textContent).not.toContain('Open Bike4Mind web');
    await openBrowser();
    expect(el('browser-pane-history').dataset.enabled).toBe('false');
    let resolveSession!: (session: ChatSession) => void;
    getSession.mockReturnValue(
      new Promise(resolve => {
        resolveSession = resolve;
      })
    );
    await searchHistory('needle');
    await act(async () => el('local-history-result').click());
    expect(el('browser-pane-history').dataset.enabled).toBe('null');
    await act(async () =>
      resolveSession({ ...SESSIONS[1], model, messages: [], historyEnabled: true } as unknown as ChatSession)
    );
    expect(el('browser-pane-history').dataset.enabled).toBe('true');
    expect(el('chat-session-title').textContent).toBe('Second');
  });

  it('hides the history status while a picked session is loading', async () => {
    getSession.mockImplementation(
      async id =>
        ({
          ...SESSIONS.find(entry => entry.id === id),
          model,
          messages: [],
          historyEnabled: true,
        }) as unknown as ChatSession
    );
    await renderShell();
    await openPanesMenu();
    expect(el('chat-history-indicator')).toBeTruthy();
    await act(async () => el('chat-panes-menu-btn').click());
    getSession.mockReturnValue(new Promise(() => undefined));
    await searchHistory('needle');
    await act(async () => el('local-history-result').click());
    await openPanesMenu();
    expect(document.querySelector('[data-testid="chat-history-indicator"]')).toBeNull();
  });
});
