// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
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

const SESSIONS = [session('first', 'First'), session('second', 'Second')];

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
      chat: quietBridge({
        listSessions: async () => SESSIONS,
        getSession: async (id: string) =>
          ({ ...SESSIONS.find(entry => entry.id === id), messages: [] }) as unknown as ChatSession,
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
const panel = () => document.querySelector<HTMLElement>('[data-testid="terminal-panel"]');

async function renderShell() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChatShell />
      </CssVarsProvider>
    );
  });
  await act(async () => undefined);
  await act(async () => el('chat-session-item').click());
  await act(async () => undefined);
}

describe('the terminal toggle', () => {
  it('sits immediately beside the browser toggle and matches it', async () => {
    await renderShell();
    const terminal = el('chat-toggle-terminal-btn');
    const browser = el('chat-toggle-browser-btn');
    // Each button is wrapped in the span its tooltip anchors to.
    expect(terminal.parentElement?.nextElementSibling).toBe(browser.parentElement);
    expect(terminal.getAttribute('aria-pressed')).toBe('false');
    expect(terminal.getAttribute('aria-label')).toBe('Show the terminal');
  });

  it('opens and closes the panel for the open conversation', async () => {
    await renderShell();
    expect(panel()).toBeNull();

    await act(async () => el('chat-toggle-terminal-btn').click());
    expect(panel()?.textContent).toBe('first');
    expect(el('chat-toggle-terminal-btn').getAttribute('aria-pressed')).toBe('true');
    expect(el('chat-toggle-terminal-btn').getAttribute('aria-label')).toBe('Hide the terminal');

    await act(async () => el('chat-toggle-terminal-btn').click());
    expect(panel()).toBeNull();
  });

  it('toggles with Ctrl+backquote', async () => {
    await renderShell();
    const press = () =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', ctrlKey: true, bubbles: true }));
      });
    await press();
    expect(panel()).not.toBeNull();
    await press();
    expect(panel()).toBeNull();
  });

  it('remembers the panel per conversation, so opening it in one does not open it in another', async () => {
    await renderShell();
    await act(async () => el('chat-toggle-terminal-btn').click());
    expect(panel()?.textContent).toBe('first');

    const rows = document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]');
    await act(async () => rows[1].click());
    await act(async () => undefined);
    expect(panel()).toBeNull();
    expect(el('chat-toggle-terminal-btn').getAttribute('aria-pressed')).toBe('false');

    await act(async () => rows[0].click());
    await act(async () => undefined);
    expect(panel()?.textContent).toBe('first');
  });
});
