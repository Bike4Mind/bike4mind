// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionMode, ChatSessionStatusEvent, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

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

const summary = (id: string, title: string, mode: ChatSessionMode, minute: number): ChatSessionSummary =>
  ({
    id,
    title,
    mode,
    messageCount: 1,
    createdAt: `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
  }) as ChatSessionSummary;

// Newest first, the order main lists them in. The Studio session is the newest of all, so a list
// that failed to filter it out would show it first.
const SESSIONS = [
  summary('s1', 'Poster studio', 'studio', 55),
  summary('c1', 'Alpha chat', 'chat', 50),
  summary('k1', 'Kappa code', 'code', 40),
  summary('c2', 'Beta chat', 'chat', 30),
  summary('k2', 'Lambda code', 'code', 20),
];

/** What listSessions returns; a test without a Studio session drops it. */
let listed: ChatSessionSummary[] = SESSIONS;
let openNotice: ((event: { sessionId: string; rootId: string }) => void) | null = null;
let statusSnapshot: ChatSessionStatusEvent[] = [];
let pushStatus: ((event: ChatSessionStatusEvent) => void) | null = null;
let createSession: Mock<(request?: { mode?: string }) => Promise<{ session: ChatSessionSummary }>>;

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
  listed = SESSIONS;
  openNotice = null;
  statusSnapshot = [];
  pushStatus = null;
  createSession = vi.fn(async (request?: { mode?: string }) => ({
    session: summary('s-new', 'New chat', request?.mode === 'studio' ? 'studio' : 'chat', 59),
  }));
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
      chat: quietBridge({
        listSessions: async () => listed,
        createSession: (request?: { mode?: string }) => createSession(request),
        getSession: async (id: string) => ({ ...SESSIONS.find(entry => entry.id === id), messages: [] }) as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => statusSnapshot,
        onSessionStatus: (listener: typeof pushStatus) => {
          pushStatus = listener;
          return () => undefined;
        },
        listModels: async () => ({ models: [] }),
      }),
      attention: quietBridge({
        onOpen: (listener: typeof openNotice) => {
          openNotice = listener;
          return () => undefined;
        },
      }),
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
      auth: quietBridge({ getState: async () => null }),
      productions: quietBridge({ list: async () => ({ ok: true, value: { items: [], nextSkip: null } }) }),
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

  it('draws Studio as a place like web Studio: no sidebar, the medium rail in the pane, Create in its own Studio session', async () => {
    await mount();
    await act(async () => el('place-rail-studio-btn').click());
    expect(find('sidebar')).toBeNull();
    expect(find('sidebar-place-title')).toBeNull();
    expect(find('studio-medium-rail')).not.toBeNull();
    expect(el('studio-area-create').getAttribute('aria-selected')).toBe('true');
    expect(find('studio-create')).not.toBeNull();
    // Create no longer borrows the Chat conversation, so it no longer names one.
    expect(find('studio-create-session')).toBeNull();
    expect(find('chat-composer-region')).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem('b4m.chat.places') ?? '{}')).toMatchObject({ studioSession: 's1' });

    // The conversation was left open underneath, so Chat comes back to it.
    await act(async () => el('place-rail-chat-btn').click());
    expect(openTitle()).toBe('Alpha chat');
  });

  it('opens a Studio session from a notification as Studio Create, not as a conversation', async () => {
    listed = [...SESSIONS, summary('s2', 'Older poster', 'studio', 10)];
    await mount();
    expect(openTitle()).toBe('Alpha chat');
    await act(async () => openNotice?.({ sessionId: 's2', rootId: 's2' }));
    expect(el('place-rail-studio-btn').getAttribute('aria-current')).toBe('page');
    expect(find('studio-create')).not.toBeNull();
    // Create is bound to the opened session, not the newest one.
    expect(JSON.parse(window.localStorage.getItem('b4m.chat.places') ?? '{}')).toMatchObject({ studioSession: 's2' });

    await act(async () => el('place-rail-chat-btn').click());
    expect(openTitle()).toBe('Alpha chat');
  });

  it('starts a Studio session the first time Studio opens, once, and keeps it out of the lists', async () => {
    listed = SESSIONS.filter(session => session.mode !== 'studio');
    await mount();
    expect(createSession).not.toHaveBeenCalled();

    await act(async () => el('place-rail-studio-btn').click());
    expect(createSession).toHaveBeenCalledExactlyOnceWith({ mode: 'studio' });
    expect(find('studio-create')).not.toBeNull();

    // Leaving and coming back reuses it rather than starting another.
    await act(async () => el('place-rail-chat-btn').click());
    expect(rowTitles()).toEqual(['Alpha chat', 'Beta chat']);
    expect(openTitle()).toBe('Alpha chat');
    await act(async () => el('place-rail-studio-btn').click());
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('says so when a Studio session cannot start, and tries once per visit', async () => {
    listed = SESSIONS.filter(session => session.mode !== 'studio');
    createSession.mockRejectedValue(new Error('cannot start a conversation while no account is signed in'));
    await mount();
    await act(async () => el('place-rail-studio-btn').click());
    expect(el('studio-create-empty').textContent).toContain('Check that you are signed in');
    expect(createSession).toHaveBeenCalledTimes(1);

    await act(async () => el('place-rail-chat-btn').click());
    await act(async () => el('place-rail-studio-btn').click());
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('collapses the sidebar on Mod+B and keeps the rail', async () => {
    await mount();
    await press({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(find('sidebar')).toBeNull();
    expect(find('place-rail')).not.toBeNull();
    // The digit chord only switches place; the sidebar stays as it was.
    await press({ key: '2', code: 'Digit2', ctrlKey: true });
    expect(find('sidebar')).toBeNull();
    await press({ key: 'b', code: 'KeyB', metaKey: true });
    expect(find('sidebar')).not.toBeNull();
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

  it('badges Agents with what needs the user, and opens a board entry in its own place', async () => {
    statusSnapshot = [{ sessionId: 'k2', status: 'needs-action' }];
    await mount();
    expect(el('place-rail-agents-badge').textContent).toBe('1');
    expect(el('place-rail-agents-btn').getAttribute('aria-label')).toBe('Agents, 1 needs you');

    await press({ key: '4', code: 'Digit4', ctrlKey: true });
    expect(el('place-rail-agents-btn').getAttribute('aria-current')).toBe('page');
    // The board is the place: no session list beside it.
    expect(find('chat-session-item')).toBeNull();
    expect(el('agents-place-group-waiting').textContent).toContain('Lambda code');

    await act(async () => el('agents-place-entry-k2').click());
    expect(el('place-rail-code-btn').getAttribute('aria-current')).toBe('page');
    expect(openTitle()).toBe('Lambda code');
  });

  it('moves the badge and the board with pushed status events, down to the empty state', async () => {
    await mount();
    await act(async () => el('place-rail-agents-btn').click());
    expect(find('agents-place-empty')).not.toBeNull();
    expect(find('place-rail-agents-badge')).toBeNull();

    await act(async () => pushStatus?.({ sessionId: 'c2', status: 'needs-action', unreadReply: true }));
    expect(el('place-rail-agents-badge').textContent).toBe('1');
    expect(el('agents-place-group-finished').textContent).toContain('Beta chat');

    await act(async () => pushStatus?.({ sessionId: 'c2', status: 'done' }));
    expect(find('place-rail-agents-badge')).toBeNull();
    expect(find('agents-place-empty')).not.toBeNull();
  });

  it('stays on Agents after a restart rather than jumping to the restored session', async () => {
    await mount();
    await act(async () => el('place-rail-agents-btn').click());
    await unmount();

    await mount();
    expect(el('place-rail-agents-btn').getAttribute('aria-current')).toBe('page');
    expect(find('agents-place')).not.toBeNull();
  });

  it('never hides the sidebar from the Agents icon, which has none', async () => {
    await mount();
    await act(async () => el('place-rail-agents-btn').click());
    await act(async () => el('place-rail-agents-btn').click());
    await act(async () => el('place-rail-chat-btn').click());
    expect(find('chat-session-item')).not.toBeNull();
  });
});
