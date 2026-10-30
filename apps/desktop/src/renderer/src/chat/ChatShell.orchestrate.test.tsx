// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { DOOR_POINT } from './orchestrator/tavern/scene';

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

const PARENT = {
  id: 'parent-1',
  title: 'Parent thread',
  mode: 'chat',
  messageCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as ChatSessionSummary;

const CHILD = {
  ...PARENT,
  id: 'child-1',
  title: 'Spawned agent',
  createdAt: '2026-10-02T00:00:00.000Z',
  origin: { parentSessionId: PARENT.id, seedPrompt: 'do a thing' },
} as ChatSessionSummary;

const PARENT_B = { ...PARENT, id: 'parent-2', title: 'Second parent' } as ChatSessionSummary;
const CHILD_B = {
  ...CHILD,
  id: 'child-2',
  title: 'Second agent',
  origin: { parentSessionId: PARENT_B.id, seedPrompt: 'do another thing' },
} as ChatSessionSummary;
const SESSIONS = [PARENT, CHILD, PARENT_B, CHILD_B];

const INTRO_SEEN_KEY = 'b4m.orchestrator.introSeen';

/**
 * Everything ChatShell reaches over IPC that this test does not care about: subscriptions hand
 * back an unsubscribe, and every call resolves to an empty list.
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
        getSession: async (id: string) =>
          ({ ...(SESSIONS.find(session => session.id === id) ?? PARENT), messages: [] }) as unknown as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [] }),
      }),
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const el = (testId: string) => {
  const found = query(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

async function clickSessionRow(title: string) {
  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')).find(candidate =>
    candidate.textContent?.includes(title)
  );
  if (!row) throw new Error(`no row ${title}`);
  await act(async () => row.click());
  await act(async () => undefined);
}

async function openParent() {
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
  await clickSessionRow(PARENT.title);
}

const enterOrchestrate = () => act(() => el('chat-orchestrate-chip').querySelector('button')?.click());

describe('orchestrate mode in the chat shell', () => {
  it('offers the chip only on a session that has spawned agents, and keeps the chat surface as before', async () => {
    await openParent();
    expect(el('chat-orchestrate-chip').textContent).toBe('1 agent \u00B7 Orchestrate');
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-thread-empty-host')).not.toBeNull();
  });

  it('shows the stage with the conversation docked beside it, and the dock toggles', async () => {
    await openParent();
    await enterOrchestrate();

    expect(query('orchestrator-stage')).not.toBeNull();
    expect(el('orchestrator-dock').querySelector('[data-testid="chat-thread-empty-host"]')).not.toBeNull();

    act(() => el('orchestrator-dock-toggle-btn').click());
    expect(query('orchestrator-dock')).toBeNull();
    expect(query('orchestrator-stage')).not.toBeNull();

    act(() => el('chat-surface-toggle-chat').click());
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-thread-empty-host')).not.toBeNull();
  });

  it('plays the tavern intro on the first entry only, then marks it seen', async () => {
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'table');
    await openParent();
    vi.useFakeTimers();
    await enterOrchestrate();

    // Forced to the tavern despite the stored view, with sprites starting at the door.
    const sprite = el(`orchestrator-tavern-agent-${CHILD.id}`);
    expect(sprite.style.left).toBe(`${DOOR_POINT.x}%`);
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBeNull();

    act(() => vi.advanceTimersByTime(1500));
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe('1');
    expect(query('orchestrator-tavern')).not.toBeNull();
    expect(window.localStorage.getItem(`b4m.orchestrator.view.${PARENT.id}`)).toBe('table');

    // Leaving and coming back uses the stored view, with no intro.
    act(() => el('chat-surface-toggle-chat').click());
    await enterOrchestrate();
    expect(query('orchestrator-tavern')).toBeNull();
    expect(query('orchestrator-table-row-child-1')).not.toBeNull();
  });

  it('restarts the intro timer when switching straight to another orchestrating session', async () => {
    window.localStorage.setItem(`b4m.orchestrator.surface.${PARENT_B.id}`, 'orchestrate');
    await openParent();
    vi.useFakeTimers();
    await enterOrchestrate();
    act(() => vi.advanceTimersByTime(1000));

    await clickSessionRow(PARENT_B.title);
    expect(query(`orchestrator-tavern-agent-${CHILD_B.id}`)).not.toBeNull();

    // The first session's timer would have fired here; the second intro gets its full run.
    act(() => vi.advanceTimersByTime(600));
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBeNull();
    act(() => vi.advanceTimersByTime(900));
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe('1');
  });

  it('opens an agent session from the stage', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'table');
    await openParent();
    await enterOrchestrate();

    await act(async () => el('orchestrator-table-row-child-1').click());
    await act(async () => el('orchestrator-peek-open-btn').click());
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe(CHILD.title);
    // The agent has spawned nothing itself, so its own session is plain chat.
    expect(query('orchestrator-stage')).toBeNull();
  });
});
