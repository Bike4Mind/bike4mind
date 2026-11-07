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
// Opened only to check header order; the pane itself is BrowserPane.test.tsx's.
vi.mock('./BrowserPane', () => ({ BrowserPane: () => <div data-testid="chat-browser-pane" /> }));

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
const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const panel = () => find('terminal-panel');
const pickPane = async (pane: string) => {
  await act(async () => el('chat-panes-menu-btn').click());
  await act(async () => el(`chat-panes-menu-${pane}-item`).click());
};

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
  it('lives in the Panes menu, with no header button while it is closed', async () => {
    await renderShell();
    expect(find('chat-toggle-terminal-btn')).toBeNull();
    expect(find('chat-toggle-browser-btn')).toBeNull();
    await act(async () => el('chat-panes-menu-btn').click());
    const row = el('chat-panes-menu-terminal-item');
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(row.textContent).toContain('Ctrl+`');
  });

  it('opens from the menu, then closes from the button it promotes into the header', async () => {
    await renderShell();
    expect(panel()).toBeNull();

    await pickPane('terminal');
    expect(panel()?.textContent).toBe('first');
    expect(el('chat-toggle-terminal-btn').getAttribute('aria-pressed')).toBe('true');
    expect(el('chat-toggle-terminal-btn').getAttribute('aria-label')).toBe('Hide the terminal');

    await act(async () => el('chat-toggle-terminal-btn').click());
    expect(panel()).toBeNull();
    expect(find('chat-toggle-terminal-btn')).toBeNull();
  });

  it('promotes open panes in a fixed order, whatever order they were opened in', async () => {
    await renderShell();
    await pickPane('browser');
    await pickPane('terminal');
    const promoted = [...document.querySelectorAll<HTMLElement>('[data-testid^="chat-toggle-"]')]
      .map(button => button.dataset.testid)
      .filter(id => id !== 'chat-toggle-session-panel-btn');
    expect(promoted).toEqual(['chat-toggle-terminal-btn', 'chat-toggle-browser-btn']);
  });

  it('promotes the button for a pane opened by the keyboard, not only by the menu', async () => {
    await renderShell();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', ctrlKey: true, bubbles: true }));
    });
    expect(el('chat-toggle-terminal-btn').getAttribute('aria-pressed')).toBe('true');
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
    await pickPane('terminal');
    expect(panel()?.textContent).toBe('first');

    const rows = document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]');
    await act(async () => rows[1].click());
    await act(async () => undefined);
    expect(panel()).toBeNull();
    expect(find('chat-toggle-terminal-btn')).toBeNull();

    await act(async () => rows[0].click());
    await act(async () => undefined);
    expect(panel()?.textContent).toBe('first');
  });
});
