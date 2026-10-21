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

// Screens and panels this test never opens, each with its own IPC to stub otherwise.
vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));

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

const ACTIVE: ChatSessionSummary = {
  id: 'open-1',
  title: 'Open thread',
  mode: 'chat',
  messageCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as ChatSessionSummary;

/**
 * Everything ChatShell reaches over IPC that this test does not care about: subscriptions hand
 * back an unsubscribe, and every call resolves to an empty list, which the snapshot readers
 * fold in as "nothing yet" and the rest ignore.
 */
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
let resolveRename: (value: ChatSessionSummary | null) => void = () => {};

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
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => [ACTIVE],
        getSession: async () => ({ ...ACTIVE, messages: [] }) as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
        renameSession: (_id: string, _title: string) =>
          new Promise<ChatSessionSummary | null>(resolve => (resolveRename = resolve)),
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

describe('renaming the open session from the sidebar', () => {
  it('updates the conversation header as well as the row', async () => {
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
    await act(async () => el('chat-session-item').click());
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe('Open thread');

    act(() => {
      el('chat-session-title-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = el('chat-session-rename-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'Renamed thread');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Before main answers: the header shows the optimistic title.
    expect(el('chat-session-title').textContent).toBe('Renamed thread');

    // A refusal rolls the header back with the row.
    await act(async () => resolveRename(null));
    expect(el('chat-session-title').textContent).toBe('Open thread');
    expect(el('chat-session-title-text').textContent).toBe('Open thread');
  });
});
