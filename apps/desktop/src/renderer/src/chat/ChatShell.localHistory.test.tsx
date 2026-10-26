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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));
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
  vi.unstubAllGlobals();
});

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

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

  it('opens a Code history result while the sidebar is in Chat mode', async () => {
    await renderShell();
    expect(el('chat-session-title').textContent).toBe('First');
    await act(async () => typeInto('chat-search-input', 'needle'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    await act(async () => el('local-history-result').click());
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe('Second');
  });

  it('keeps the consent switch out of the header and hands it to the browser pane', async () => {
    await renderShell();
    expect(document.querySelector('[data-testid="chat-history-switch"]')).toBeNull();
    await act(async () => el('chat-toggle-browser-btn').click());
    expect(el('browser-pane-history').dataset.enabled).toBe('false');
    await act(async () => el('browser-pane-history').click());
    expect(setSessionHistory).toHaveBeenCalledWith('first', true);
    expect(el('browser-pane-history').dataset.enabled).toBe('true');
  });

  it('hides the previous consent switch until a selected history result has loaded', async () => {
    await renderShell();
    await act(async () => el('chat-toggle-browser-btn').click());
    expect(el('browser-pane-history').dataset.enabled).toBe('false');
    let resolveSession!: (session: ChatSession) => void;
    getSession.mockReturnValue(
      new Promise(resolve => {
        resolveSession = resolve;
      })
    );
    await act(async () => typeInto('chat-search-input', 'needle'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    await act(async () => el('local-history-result').click());
    expect(el('browser-pane-history').dataset.enabled).toBe('null');
    await act(async () =>
      resolveSession({ ...SESSIONS[1], model, messages: [], historyEnabled: true } as unknown as ChatSession)
    );
    expect(el('browser-pane-history').dataset.enabled).toBe('true');
  });

  it.each([true, false])('shows the header indicator only while history is on (on: %s)', async on => {
    getSession.mockImplementation(
      async id =>
        ({
          ...SESSIONS.find(entry => entry.id === id),
          model,
          messages: [],
          historyEnabled: on,
        }) as unknown as ChatSession
    );
    await renderShell();
    expect(document.querySelector('[data-testid="chat-history-indicator"]') !== null).toBe(on);
  });

  it('hides the header indicator while a picked session is loading', async () => {
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
    expect(el('chat-history-indicator')).toBeTruthy();
    getSession.mockReturnValue(new Promise(() => undefined));
    await act(async () => typeInto('chat-search-input', 'needle'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    await act(async () => el('local-history-result').click());
    expect(document.querySelector('[data-testid="chat-history-indicator"]')).toBeNull();
  });
});
