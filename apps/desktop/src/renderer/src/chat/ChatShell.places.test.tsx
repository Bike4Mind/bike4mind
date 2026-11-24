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
vi.mock('./CustomizePanel', () => ({ CustomizeScreen: () => null, useCustomizeAttention: () => undefined }));

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

const summary = (id: string, title: string, mode: 'chat' | 'code', minute: number): ChatSessionSummary =>
  ({
    id,
    title,
    mode,
    messageCount: 1,
    createdAt: `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
  }) as ChatSessionSummary;

// Newest first, the order main lists them in.
const SESSIONS = [
  summary('c1', 'Alpha chat', 'chat', 50),
  summary('k1', 'Kappa code', 'code', 40),
  summary('c2', 'Beta chat', 'chat', 30),
  summary('k2', 'Lambda code', 'code', 20),
];

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
        getSession: async (id: string) => ({ ...SESSIONS.find(entry => entry.id === id), messages: [] }) as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
      }),
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
      // No Studio bridge: the place frame must still draw, with the pane saying it is not connected.
      studio: undefined,
      getAppInfo: () => new Promise(() => {}),
    },
    {
      get(target, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        return name in target ? target[name as keyof typeof target] : quietBridge({});
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

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const el = (testId: string) => {
  const found = find(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};
const rowTitles = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')].map(
    row => SESSIONS.find(session => row.textContent?.includes(session.title))?.title
  );
const openTitle = () => find('chat-session-title')?.textContent;
const press = (init: KeyboardEventInit) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });

async function mount() {
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
}

async function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

describe('places on the rail', () => {
  it("lists only the place's sessions, and names the place in the sidebar header", async () => {
    await mount();
    expect(el('place-rail-chat-btn').getAttribute('aria-current')).toBe('page');
    expect(el('sidebar-place-title').textContent).toBe('Chat');
    expect(rowTitles()).toEqual(['Alpha chat', 'Beta chat']);
    expect(find('mode-switcher')).toBeNull();

    await act(async () => el('place-rail-code-btn').click());
    expect(el('sidebar-place-title').textContent).toBe('Code');
    expect(rowTitles()).toEqual(['Kappa code', 'Lambda code']);
    expect(openTitle()).toBe('Kappa code');
  });

  it('switches places with the primary modifier and digits (Ctrl off macOS)', async () => {
    await mount();
    await press({ key: '2', code: 'Digit2', ctrlKey: true });
    expect(el('place-rail-code-btn').getAttribute('aria-current')).toBe('page');
    await press({ key: '3', code: 'Digit3', ctrlKey: true });
    expect(find('studio-place')).not.toBeNull();
    await press({ key: '1', code: 'Digit1', ctrlKey: true });
    expect(el('place-rail-chat-btn').getAttribute('aria-current')).toBe('page');
  });

  it('opens the nth session on the session chord (Alt off macOS) without changing place', async () => {
    await mount();
    await press({ key: '2', code: 'Digit2', altKey: true });
    expect(openTitle()).toBe('Beta chat');
    expect(el('place-rail-chat-btn').getAttribute('aria-current')).toBe('page');
  });

  it('returns to the session last open in each place', async () => {
    await mount();
    await act(async () => el('place-rail-code-btn').click());
    const lambda = [...document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')].find(row =>
      row.textContent?.includes('Lambda code')
    );
    await act(async () => lambda?.click());
    expect(openTitle()).toBe('Lambda code');

    await act(async () => el('place-rail-chat-btn').click());
    expect(openTitle()).toBe('Alpha chat');
    await act(async () => el('place-rail-code-btn').click());
    expect(openTitle()).toBe('Lambda code');
  });

  it('restores the last place after a restart', async () => {
    await mount();
    await act(async () => el('place-rail-studio-btn').click());
    await act(async () => el('studio-area-productions').click());
    expect(JSON.parse(window.localStorage.getItem('b4m.chat.places') ?? '{}')).toMatchObject({
      place: 'studio',
      studio: 'productions',
    });
    await unmount();

    await mount();
    expect(el('place-rail-studio-btn').getAttribute('aria-current')).toBe('page');
    expect(find('studio-productions-empty')).not.toBeNull();
  });

  it('draws Studio as a place: the media in the sidebar, Create saving to the open conversation', async () => {
    await mount();
    await act(async () => el('place-rail-studio-btn').click());
    expect(find('sidebar')).toBeNull();
    expect(el('sidebar-place-title').textContent).toBe('Studio');
    expect(find('studio-sidebar-image-btn')).not.toBeNull();
    expect(el('studio-area-create').getAttribute('aria-selected')).toBe('true');
    expect(el('studio-create-session').textContent).toBe('Saves to Alpha chat');
    expect(find('chat-composer-region')).toBeNull();

    // The conversation was left open underneath, so Chat comes back to it.
    await act(async () => el('place-rail-chat-btn').click());
    expect(openTitle()).toBe('Alpha chat');
  });

  it('collapses the sidebar on Mod+B and keeps the rail', async () => {
    await mount();
    await press({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(find('sidebar')).toBeNull();
    expect(find('place-rail')).not.toBeNull();
    // The digit chord only switches place; the sidebar stays as it was.
    await press({ key: '3', code: 'Digit3', ctrlKey: true });
    expect(find('studio-sidebar')).toBeNull();
    await press({ key: 'b', code: 'KeyB', metaKey: true });
    expect(find('studio-sidebar')).not.toBeNull();
  });

  it('reopens a collapsed sidebar from any rail icon, and hides it from the active one', async () => {
    await mount();
    await act(async () => el('place-rail-chat-btn').click());
    expect(find('sidebar')).toBeNull();
    expect(el('place-rail-chat-btn').getAttribute('aria-current')).toBe('page');

    await act(async () => el('place-rail-chat-btn').click());
    expect(find('sidebar')).not.toBeNull();

    await press({ key: 'b', code: 'KeyB', ctrlKey: true });
    await act(async () => el('place-rail-code-btn').click());
    expect(el('sidebar-place-title').textContent).toBe('Code');
    expect(el('place-rail-code-btn').getAttribute('aria-current')).toBe('page');
  });
});
