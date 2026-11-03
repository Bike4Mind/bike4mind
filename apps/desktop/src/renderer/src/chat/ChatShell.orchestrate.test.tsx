// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type {
  ChatMessage,
  ChatModelOption,
  ChatSession,
  ChatSessionStatusEvent,
  ChatSessionSummary,
} from '@shared/chat';
import type { AttentionOpenEvent } from '@shared/attention';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { DOOR_POINT } from './orchestrator/tavern/scene';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Screens and panels this test never opens, each with its own IPC to stub otherwise.
vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));

const threadMounts = vi.hoisted(() => ({ count: 0 }));
// The real thread, counting its mounts.
vi.mock('./MessageThread', async importOriginal => {
  const actual = await importOriginal<typeof import('./MessageThread')>();
  const { useEffect } = await import('react');
  type Props = Parameters<typeof actual.MessageThread>[0];
  return {
    ...actual,
    MessageThread: (props: Props) => {
      useEffect(() => {
        threadMounts.count += 1;
      }, []);
      return <actual.MessageThread {...props} />;
    },
  };
});

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
// A Code session with no agents yet: the one place Orchestrate can be started from nothing.
const CODE = {
  ...PARENT,
  id: 'code-1',
  title: 'Code thread',
  mode: 'code',
  model: 'test-model',
  project: {
    directory: '/work/repo',
    name: 'repo',
    branch: 'main',
    workspace: false,
    workingDirectory: '/work/repo',
    contextDirectories: [],
  },
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
const streamUnsubscribe = vi.fn();
const onStreamEvent = vi.fn(() => streamUnsubscribe);
let listed: ChatSessionSummary[] = SESSIONS;
let statusSnapshot: ChatSessionStatusEvent[] = [];
let statusListener: ((event: ChatSessionStatusEvent) => void) | null = null;
let parentMessages: ChatMessage[] = [];
let attentionOpen: ((event: AttentionOpenEvent) => void) | null = null;
let catalogModels: ChatModelOption[] = [];
const setSessionOrchestrate = vi.fn(async (id: string, orchestrate: boolean) => {
  const found = listed.find(session => session.id === id);
  if (!found) return null;
  const { orchestrate: _previous, ...rest } = found;
  const updated = (orchestrate ? { ...rest, orchestrate: true } : rest) as ChatSessionSummary;
  listed = listed.map(session => (session.id === id ? updated : session));
  return updated;
});

beforeEach(() => {
  window.localStorage.clear();
  listed = SESSIONS;
  catalogModels = [];
  statusSnapshot = [];
  statusListener = null;
  parentMessages = [];
  attentionOpen = null;
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
        onStreamEvent,
        listSessions: async () => listed,
        getSession: async (id: string) =>
          ({
            ...(listed.find(session => session.id === id) ?? PARENT),
            messages: id === PARENT.id ? parentMessages : [],
          }) as unknown as ChatSession,
        setSessionOrchestrate,
        inspectProject: async () => ({ currentBranch: 'main', branches: [] }),
        workspaceChanges: async () => null,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => statusSnapshot,
        onSessionStatus: (listener: (event: ChatSessionStatusEvent) => void) => {
          statusListener = listener;
          return () => undefined;
        },
        listModels: async () => ({ models: catalogModels }),
      }),
      sidebar: quietBridge({ getSections: async () => EMPTY_SIDEBAR_SECTIONS }),
      pullRequests: quietBridge({ watch: async () => null }),
      attention: quietBridge({
        onOpen: (listener: (event: AttentionOpenEvent) => void) => {
          attentionOpen = listener;
          return () => undefined;
        },
      }),
      // A Code session's chips shorten paths against the home directory.
      getAppInfo: async () => ({ homeDirectory: '/home/user' }),
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

async function openParent(title: string = PARENT.title, mode: 'chat' | 'code' = 'chat') {
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
  if (mode === 'code') await act(async () => el('mode-switch-code-btn').click());
  await clickSessionRow(title);
}

const enterOrchestrate = () => act(() => el('chat-surface-toggle-orchestrate').click());

describe('orchestrate mode in the chat shell', () => {
  it('offers the toggle only on a session that has spawned agents, and keeps the chat surface as before', async () => {
    await openParent();
    expect(el('chat-orchestrate-count').textContent).toBe('1');
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

  it('keeps the same thread mounted across surface and dock toggles', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    const mountsBefore = threadMounts.count;

    await enterOrchestrate();
    act(() => el('orchestrator-dock-toggle-btn').click());
    // Hidden, not unmounted.
    expect(el('orchestrator-dock-hidden').querySelector('[data-testid="chat-thread-empty-host"]')).not.toBeNull();
    act(() => el('orchestrator-dock-toggle-btn').click());
    act(() => el('chat-surface-toggle-chat').click());
    await enterOrchestrate();
    act(() => el('chat-surface-toggle-chat').click());

    expect(threadMounts.count).toBe(mountsBefore);
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

  it('subscribes to agent activity only while orchestrating', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    const chatSubscriptions = onStreamEvent.mock.calls.length;

    await enterOrchestrate();
    expect(onStreamEvent).toHaveBeenCalledTimes(chatSubscriptions + 1);

    const unsubscribedBefore = streamUnsubscribe.mock.calls.length;
    act(() => el('chat-surface-toggle-chat').click());
    expect(streamUnsubscribe).toHaveBeenCalledTimes(unsubscribedBefore + 1);
  });

  it('starts a fresh stage when switching between orchestrating parents', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    for (const parent of [PARENT, PARENT_B]) {
      window.localStorage.setItem(`b4m.orchestrator.view.${parent.id}`, 'table');
      window.localStorage.setItem(`b4m.orchestrator.surface.${parent.id}`, 'orchestrate');
    }
    await openParent();
    act(() => el('orchestrator-table-sort-agent').click());
    expect(el('orchestrator-table-sort-agent').getAttribute('aria-sort')).toBe('ascending');

    await clickSessionRow(PARENT_B.title);
    expect(query(`orchestrator-table-row-${CHILD_B.id}`)).not.toBeNull();
    expect(el('orchestrator-table-sort-agent').getAttribute('aria-sort')).toBe('none');
  });

  it('never drops stored prefs for sessions outside the current listing', async () => {
    window.localStorage.setItem('b4m.orchestrator.view.other-scope', 'board');
    window.localStorage.setItem('b4m.orchestrator.surface.other-scope', 'orchestrate');
    await openParent();
    expect(window.localStorage.getItem('b4m.orchestrator.view.other-scope')).toBe('board');
    expect(window.localStorage.getItem('b4m.orchestrator.surface.other-scope')).toBe('orchestrate');
  });

  it('offers no toggle on a chat session with no agents', async () => {
    listed = [...SESSIONS, { ...PARENT, id: 'plain-1', title: 'Plain chat' } as ChatSessionSummary];
    await openParent('Plain chat');
    expect(query('chat-surface-toggle-orchestrate')).toBeNull();
  });

  it('starts orchestrating an empty code session from its toggle, with an empty stage and the delegate switch on', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    listed = [...SESSIONS, CODE];
    await openParent(CODE.title, 'code');
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('Orchestrate');

    await act(async () => el('chat-surface-toggle-orchestrate').click());
    expect(setSessionOrchestrate).toHaveBeenCalledWith(CODE.id, true);
    expect(el('orchestrator-empty-state').textContent).toContain('Describe the work');
    act(() => el('orchestrator-example-quest-1').click());
    const composer = el('chat-composer-input') as HTMLTextAreaElement;
    expect(composer.value).toMatch(/^Audit this repository using several agents in parallel/);
    expect(document.activeElement).toBe(composer);
    expect(el('orchestrator-dock').querySelector('[data-testid="chat-thread-empty-host"]')).not.toBeNull();
    const delegate = () => el('orchestrator-delegate-switch').querySelector('input');
    expect(delegate()?.checked).toBe(true);

    // Back to Chat leaves the behaviour on; only the switch turns it off.
    act(() => el('chat-surface-toggle-chat').click());
    expect(query('orchestrator-stage')).toBeNull();
    expect(setSessionOrchestrate).toHaveBeenCalledTimes(1);

    await act(async () => el('chat-surface-toggle-orchestrate').click());
    expect(setSessionOrchestrate).toHaveBeenCalledTimes(1);
    await act(async () => delegate()?.click());
    expect(setSessionOrchestrate).toHaveBeenLastCalledWith(CODE.id, false);
    // Off with no agents, the stage has nothing to show and falls back to the conversation.
    expect(query('orchestrator-stage')).toBeNull();
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('Orchestrate');
  });

  it('reopens an empty code session on the conversation when its surface was left on orchestrate but the flag is off', async () => {
    window.localStorage.setItem(`b4m.orchestrator.surface.${CODE.id}`, 'orchestrate');
    listed = [...SESSIONS, CODE];
    await openParent(CODE.title, 'code');
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-thread-empty-host')).not.toBeNull();
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('Orchestrate');
  });

  it('keeps the empty stage for a code session whose flag is on', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.surface.${CODE.id}`, 'orchestrate');
    listed = [...SESSIONS, { ...CODE, orchestrate: true } as ChatSessionSummary];
    await openParent(CODE.title, 'code');
    expect(query('orchestrator-empty-state')).not.toBeNull();
  });

  it('offers neither the toggle nor the switch on a code session whose model has no tools', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.surface.${CODE.id}`, 'orchestrate');
    catalogModels = [{ id: 'no-tools', name: 'No tools', supportsTools: false } as ChatModelOption];
    listed = [...SESSIONS, { ...CODE, model: 'no-tools', orchestrate: true } as ChatSessionSummary];
    await openParent(CODE.title, 'code');
    expect(query('chat-surface-toggle-orchestrate')).toBeNull();
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('orchestrator-delegate-switch')).toBeNull();
  });

  it('offers no orchestrate controls on a code agent at the spawn depth cap, even with the flag on', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const deep = {
      ...CODE,
      id: 'code-deep',
      title: 'Deep agent',
      orchestrate: true,
      origin: { parentSessionId: CODE.id, depth: 2, seedPrompt: 'deep' },
    } as ChatSessionSummary;
    window.localStorage.setItem(`b4m.orchestrator.surface.${deep.id}`, 'orchestrate');
    listed = [...SESSIONS, CODE, deep];
    await openParent(deep.title, 'code');
    expect(el('chat-session-title').textContent).toBe(deep.title);
    expect(query('chat-surface-toggle-orchestrate')).toBeNull();
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('orchestrator-delegate-switch')).toBeNull();
  });

  it('offers the toggle on a code agent below the depth cap', async () => {
    const shallow = {
      ...CODE,
      id: 'code-shallow',
      title: 'Shallow agent',
      origin: { parentSessionId: CODE.id, depth: 1, seedPrompt: 'shallow' },
    } as ChatSessionSummary;
    listed = [...SESSIONS, CODE, shallow];
    await openParent(shallow.title, 'code');
    expect(el('chat-session-title').textContent).toBe(shallow.title);
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('Orchestrate');
  });

  it('leaves the delegate switch out of a chat session stage', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    expect(query('orchestrator-stage')).not.toBeNull();
    expect(query('orchestrator-delegate-switch')).toBeNull();
  });

  it('brings the parent conversation forward when the Innkeeper is clicked, reopening a hidden dock', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    act(() => el('orchestrator-dock-toggle-btn').click());
    expect(query('orchestrator-dock')).toBeNull();

    await act(async () => el('orchestrator-tavern-innkeeper').click());
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(document.activeElement).toBe(el('chat-composer-input'));
  });

  it('celebrates a quest_complete summary and reads the report by scrolling to it', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const at = '2026-10-01T00:00:00.000Z';
    parentMessages = [
      { id: 'a1', role: 'assistant', content: 'Spawning agents', createdAt: at },
      { id: 'r1', role: 'user', content: 'Report from agent one', createdAt: at, system: true },
      {
        id: 'a2',
        role: 'assistant',
        content: 'The combined report',
        createdAt: '2026-10-01T00:10:00.000Z',
        questComplete: true,
      },
      { id: 'a3', role: 'assistant', content: 'Anything else?', createdAt: '2026-10-01T00:11:00.000Z' },
    ] as ChatMessage[];
    statusSnapshot = [{ sessionId: CHILD.id, status: 'processing' }];
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    await openParent();
    await enterOrchestrate();
    act(() => el('orchestrator-dock-toggle-btn').click());

    vi.useFakeTimers();
    await act(async () => statusListener?.({ sessionId: CHILD.id, status: 'done' }));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(el('orchestrator-finale').textContent).toContain('Quest complete');

    scrolled.length = 0;
    await act(async () => el('orchestrator-finale-read-btn').click());
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(query('orchestrator-finale')).toBeNull();
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(scrolled.at(-1)?.textContent).toContain('The combined report');
    expect(scrolled.at(-1)?.hasAttribute('data-report-highlight')).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(scrolled.at(-1)?.hasAttribute('data-report-highlight')).toBe(false);
  });

  it('holds the finale for a reply that settled the run but was not marked by quest_complete', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const at = '2026-10-01T00:00:00.000Z';
    parentMessages = [
      { id: 'a1', role: 'assistant', content: 'Spawning agents', createdAt: at },
      { id: 'r1', role: 'user', content: 'Report from agent one', createdAt: at, system: true },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Waiting for the install to finish',
        createdAt: '2026-10-01T00:10:00.000Z',
      },
    ] as ChatMessage[];
    statusSnapshot = [{ sessionId: CHILD.id, status: 'processing' }];
    await openParent();
    await enterOrchestrate();

    vi.useFakeTimers();
    await act(async () => statusListener?.({ sessionId: CHILD.id, status: 'done' }));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(query('orchestrator-finale')).toBeNull();
  });

  it("opens a clicked notice's agent: selects its parent, orchestrates, and peeks the agent", async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'table');
    await openParent(PARENT_B.title);
    expect(query('orchestrator-stage')).toBeNull();

    await act(async () => attentionOpen?.({ sessionId: CHILD.id, rootId: PARENT.id }));
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe(PARENT.title);
    expect(query('orchestrator-stage')).not.toBeNull();
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
  });

  it('ignores a clicked notice whose session has since been deleted, staying on the open conversation', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent(PARENT_B.title);

    await act(async () => attentionOpen?.({ sessionId: 'deleted-agent', rootId: 'deleted-parent' }));
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe(PARENT_B.title);
    expect(window.localStorage.getItem('b4m.orchestrator.surface.deleted-parent')).toBeNull();
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
