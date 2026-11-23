// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { CssVarsProvider } from '@mui/joy/styles';
import type {
  ChatMessage,
  ChatModelOption,
  ChatSession,
  ChatSessionStatusEvent,
  ChatSessionSummary,
} from '@shared/chat';
import type { AttentionOpenEvent } from '@shared/attention';
import type { PrBarState } from '@shared/pullRequest';
import { EMPTY_SIDEBAR_SECTIONS } from '@shared/sidebarSections';
import { inheritancePolicy } from '@shared/orchestration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { DOOR_POINT } from './orchestrator/tavern/scene';
import { reloadReplyStatsPrefs } from './replyStatsPrefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Screens and panels this test never opens, each with its own IPC to stub otherwise.
vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));
vi.mock('./BrowserPane', () => ({
  BrowserPane: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="test-browser-pane" data-session-id={sessionId} />
  ),
}));

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
      return (
        <>
          <actual.MessageThread {...props} />
          {createPortal(<button data-testid="thread-portal-control">Portal control</button>, document.body)}
        </>
      );
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
let codeMessages: ChatMessage[] = [];
let childMessages: ChatMessage[] = [];
let attentionOpen: ((event: AttentionOpenEvent) => void) | null = null;
let sessionsChanged: (() => void) | null = null;
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
  codeMessages = [];
  childMessages = [];
  attentionOpen = null;
  sessionsChanged = null;
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
            messages:
              id === PARENT.id ? parentMessages : id === CODE.id ? codeMessages : id === CHILD.id ? childMessages : [],
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
      // The one push that re-lists sessions, standing in for an agent being spawned or deleted.
      claudeImport: quietBridge({
        onSessionsChanged: (listener: () => void) => {
          sessionsChanged = listener;
          return () => undefined;
        },
      }),
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

async function relist(sessions: ChatSessionSummary[]) {
  listed = sessions;
  await act(async () => sessionsChanged?.());
  await act(async () => undefined);
}

describe('orchestrate mode in the chat shell', () => {
  it('opens agent PR and CI links in the parent browser without changing its watch, scene or dialog', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const ref = {
      owner: 'example-org',
      repo: 'widgets',
      number: 611,
      url: 'https://github.com/example-org/widgets/pull/611',
    };
    const state: PrBarState = {
      sessionId: CHILD.id,
      binding: { ...ref, source: 'shell', boundAt: '' },
      snapshot: {
        ...ref,
        title: 'Widget change',
        author: 'octo-dev',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'feat/widget',
        headSha: 'head',
        baseRefName: 'main',
        baseSha: 'base',
        additions: 1,
        deletions: 0,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'REVIEW_REQUIRED',
        autoMergeArmed: false,
        checks: [],
        repoSettings: { autoMergeAllowed: false, allowedMethods: ['squash'] },
        viewer: 'octo-dev',
        fetchedAt: 0,
      },
      gh: 'ok',
      refreshing: false,
      autoFix: { status: 'off', attempts: 0, max: 5 },
      autoMerge: { mode: null },
    };
    const watch = vi.fn().mockResolvedValue(null);
    const navigate = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.b4m.pullRequests, {
      watch,
      getSummaries: async () => [{ sessionId: CHILD.id, summary: { number: 611, state: 'open' } }],
      getState: vi.fn().mockResolvedValue(state),
    });
    Object.assign(window.b4m, { browser: quietBridge({ navigate }) });
    await openParent();
    await enterOrchestrate();
    const stage = el('orchestrator-stage');
    const scene = el('orchestrator-tavern');
    await act(async () => el('orchestrator-pr-indicator').click());
    const dialog = el('orchestrator-pr-dialog');
    watch.mockClear();
    await act(async () => el('pr-bar-open-btn').click());
    expect(navigate).toHaveBeenLastCalledWith({ sessionId: PARENT.id, url: ref.url });
    expect(el('test-browser-pane').dataset.sessionId).toBe(PARENT.id);
    await act(async () => el('pr-bar-ci-btn').click());
    await act(async () => el('pr-ci-open-btn').click());
    expect(navigate).toHaveBeenLastCalledWith({ sessionId: PARENT.id, url: `${ref.url}/checks` });
    expect(watch).not.toHaveBeenCalled();
    expect(el('orchestrator-stage')).toBe(stage);
    expect(el('orchestrator-tavern')).toBe(scene);
    expect(el('orchestrator-pr-dialog')).toBe(dialog);
  });

  it('offers the toggle only on a session that has spawned agents, and keeps the chat surface as before', async () => {
    await openParent();
    expect(el('chat-orchestrate-count').textContent).toBe('1');
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-thread-empty-host')).not.toBeNull();
  });

  it.each(['tavern', 'aquarium'] as const)(
    'overlays the single parent thread on the %s scene and gives agent details Escape priority',
    async view => {
      window.localStorage.setItem(INTRO_SEEN_KEY, '1');
      window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, view);
      await openParent();
      const thread = el('chat-thread-empty-host');
      const mounts = threadMounts.count;
      await enterOrchestrate();
      const dock = el('orchestrator-dock');
      expect(dock.hasAttribute('data-scene-conversation')).toBe(true);
      expect(getComputedStyle(dock).position).toBe('absolute');
      expect(query('orchestrator-dock-resize-handle')).toBeNull();
      const scene = el(view === 'tavern' ? 'orchestrator-tavern' : 'orchestrator-aquarium');
      expect(getComputedStyle(scene).getPropertyValue('anchor-name')).toBe('--orchestrator-scene');
      const agent = el(view === 'tavern' ? `orchestrator-tavern-agent-${CHILD.id}` : `orchestrator-fish-${CHILD.id}`);
      await act(async () => agent.click());
      expect(el('orchestrator-stage').getAttribute('data-agent-details-open')).toBe('true');
      await act(async () => el('orchestrator-dock-toggle-btn').click());
      expect(query('orchestrator-peek-drawer')).toBeNull();
      expect(query('orchestrator-dock')).not.toBeNull();
      await act(async () => agent.click());
      act(() =>
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      );
      expect(query('orchestrator-peek-drawer')).toBeNull();
      expect(query('orchestrator-dock-hidden')).not.toBeNull();
      expect(el('chat-thread-empty-host')).toBe(thread);
      expect(threadMounts.count).toBe(mounts + 2);
      await act(async () => el('orchestrator-dock-toggle-btn').click());
      act(() =>
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      );
      expect(query('orchestrator-dock-hidden')).not.toBeNull();
      expect(el('chat-thread-empty-host')).toBe(thread);
    }
  );

  it('keeps the parent scene thread mounted through ambient settle and wake', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    const thread = el('chat-thread-empty-host');
    const mounts = threadMounts.count;
    vi.useFakeTimers();
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(46000));
    expect(query('orchestrator-dock-hidden')).not.toBeNull();
    expect(el('chat-thread-empty-host')).toBe(thread);
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(threadMounts.count).toBe(mounts);
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

  it("hides the dock from its own close button and hands focus to the header's dock toggle", async () => {
    await openParent();
    await enterOrchestrate();
    expect(query('orchestrator-dock')).not.toBeNull();

    act(() => el('orchestrator-dock-close-btn').click());
    expect(query('orchestrator-dock')).toBeNull();
    expect(query('orchestrator-dock-hidden')).not.toBeNull();
    expect(document.activeElement).toBe(el('orchestrator-dock-toggle-btn'));
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

  it('turning Orchestrate on exposes an empty agents scene while starting in conversation', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    listed = [...SESSIONS, CODE];
    await openParent(CODE.title, 'code');
    expect(query('chat-surface-toggle')).toBeNull();
    expect(query('orchestrate-example-quests')).toBeNull();

    await act(async () => el('composer-orchestrate-toggle').click());
    expect(setSessionOrchestrate).toHaveBeenCalledWith(CODE.id, true);
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(query('chat-surface-toggle')).not.toBeNull();
    expect(query('orchestrator-stage')).toBeNull();

    act(() => el('orchestrator-example-quest-1').click());
    const composer = el('chat-composer-input') as HTMLTextAreaElement;
    expect(composer.value).toMatch(/^Audit this repository using several agents in parallel/);
    expect(document.activeElement).toBe(composer);

    await enterOrchestrate();
    expect(query('orchestrator-stage')).not.toBeNull();
    expect(query('orchestrator-example-quest-1')).toBeNull();
    await act(async () => el('composer-orchestrate-toggle').click());
    expect(setSessionOrchestrate).toHaveBeenLastCalledWith(CODE.id, false);
    expect(query('orchestrate-example-quests')).toBeNull();
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-surface-toggle')).toBeNull();
  });

  it('keeps the run policy off the composer and in the Orchestrate tooltip', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const orchestrating = {
      ...CODE,
      orchestrate: true,
      orchestrationPolicy: {
        rootSessionId: CODE.id,
        rootRunId: 'run-1',
        policy: {
          ...inheritancePolicy(),
          roles: { implementation: 'gone', exploration: 'inherit', review: 'inherit' },
        },
      },
    } as ChatSessionSummary;
    listed = [...SESSIONS, orchestrating];
    catalogModels = [{ id: 'test-model', name: 'Test Model', supportsTools: true }];
    await openParent(CODE.title, 'code');
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(query('orchestration-policy-summary')).toBeNull();
    expect(query('composer-orchestrate-unavailable')).not.toBeNull();

    await act(async () => {
      el('composer-orchestrate-toggle').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // Joy's Tooltip opens after its enter delay (100ms).
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    expect(el('orchestration-policy-summary').textContent).toContain(
      'implementation: gone (unavailable; choose a replacement)'
    );
  });

  it('does not offer example quests on an orchestrating session that already has a transcript', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    codeMessages = [{ id: 'm1', role: 'user', content: 'Earlier question', createdAt: '2026-10-01T00:00:00.000Z' }];
    listed = [...SESSIONS, { ...CODE, orchestrate: true } as ChatSessionSummary];
    await openParent(CODE.title, 'code');
    expect(query('orchestrate-example-quests')).toBeNull();
  });

  it("opens a new Code session on its project's last view", async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem('b4m.orchestrator.projectView./work/repo', 'table');
    const code = { ...CODE, orchestrate: true } as ChatSessionSummary;
    const agent = { ...CHILD, id: 'code-child', mode: 'code', origin: { parentSessionId: CODE.id, seedPrompt: 'x' } };
    listed = [...SESSIONS, code, agent as ChatSessionSummary];
    await openParent(CODE.title, 'code');
    await enterOrchestrate();
    expect(query('orchestrator-table-row-code-child')).not.toBeNull();
  });

  it('keeps the agents switch available before and after the first agent spawns', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const code = { ...CODE, orchestrate: true } as ChatSessionSummary;
    listed = [...SESSIONS, code];
    await openParent(CODE.title, 'code');
    expect(query('chat-surface-toggle')).not.toBeNull();
    expect(el('chat-orchestrate-count').textContent).toBe('0');

    const agent = { ...CHILD, id: 'code-child', mode: 'code', origin: { parentSessionId: CODE.id, seedPrompt: 'x' } };
    await relist([...SESSIONS, code, agent as ChatSessionSummary]);
    expect(el('chat-orchestrate-count').textContent).toBe('1');
    expect(query('orchestrate-example-quests')).toBeNull();
    await enterOrchestrate();
    expect(query('orchestrator-stage')).not.toBeNull();
  });

  it('falls back to the conversation when the last agent goes away while the stage is shown', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    expect(query('orchestrator-stage')).not.toBeNull();

    await relist([PARENT, PARENT_B, CHILD_B]);
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-surface-toggle')).toBeNull();
    expect(window.localStorage.getItem(`b4m.orchestrator.surface.${PARENT.id}`)).toBeNull();

    // A new agent later does not throw the user back onto the stage.
    await relist(SESSIONS);
    expect(query('chat-surface-toggle')).not.toBeNull();
    expect(query('orchestrator-stage')).toBeNull();
  });

  it('says so and leaves the toggle off when changing Orchestrate fails', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    listed = [...SESSIONS, CODE];
    await openParent(CODE.title, 'code');

    setSessionOrchestrate.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => el('composer-orchestrate-toggle').click());
    expect(el('chat-notice').textContent).toContain('Could not change Orchestrate. disk full');
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('false');

    setSessionOrchestrate.mockResolvedValueOnce(null);
    await act(async () => el('composer-orchestrate-toggle').click());
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('false');
  });

  it('restores the agents surface for an enabled agentless session', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.surface.${CODE.id}`, 'orchestrate');
    listed = [...SESSIONS, { ...CODE, orchestrate: true } as ChatSessionSummary];
    await openParent(CODE.title, 'code');
    expect(query('orchestrator-stage')).not.toBeNull();
    expect(query('orchestrate-example-quests')).toBeNull();
    expect(window.localStorage.getItem(`b4m.orchestrator.surface.${CODE.id}`)).toBe('orchestrate');
  });

  it('offers neither the toggle nor the switch on a code session whose model has no tools', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.surface.${CODE.id}`, 'orchestrate');
    catalogModels = [{ id: 'no-tools', name: 'No tools', supportsTools: false } as ChatModelOption];
    listed = [...SESSIONS, { ...CODE, model: 'no-tools', orchestrate: true } as ChatSessionSummary];
    await openParent(CODE.title, 'code');
    expect(query('chat-surface-toggle-orchestrate')).toBeNull();
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('composer-orchestrate-toggle')).toBeNull();
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
    expect(query('composer-orchestrate-toggle')).toBeNull();
  });

  it('offers the Orchestrate pill on a code agent below the depth cap', async () => {
    const shallow = {
      ...CODE,
      id: 'code-shallow',
      title: 'Shallow agent',
      origin: { parentSessionId: CODE.id, depth: 1, seedPrompt: 'shallow' },
    } as ChatSessionSummary;
    listed = [...SESSIONS, CODE, shallow];
    await openParent(shallow.title, 'code');
    expect(el('chat-session-title').textContent).toBe(shallow.title);
    expect(query('composer-orchestrate-toggle')).not.toBeNull();
    // It has spawned nothing yet, so there is no agents view to switch to.
    expect(query('chat-surface-toggle')).toBeNull();
  });

  it('leaves the Orchestrate toggle out of a chat session', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    expect(query('orchestrator-stage')).not.toBeNull();
    expect(query('composer-orchestrate-toggle')).toBeNull();
  });

  it('toggles the conversation directly from the Innkeeper and brings it forward over an agent peek', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    act(() => el('orchestrator-dock-toggle-btn').click());
    expect(query('orchestrator-dock')).toBeNull();

    await act(async () => el('orchestrator-tavern-innkeeper').click());
    expect(query('orchestrator-tavern-order-slip')).toBeNull();
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(document.activeElement).toBe(el('chat-composer-input'));
    await act(async () => el('orchestrator-tavern-innkeeper').click());
    expect(query('orchestrator-dock')).toBeNull();
    await act(async () => el('orchestrator-tavern-innkeeper').click());
    await act(async () => el(`orchestrator-tavern-agent-${CHILD.id}`).click());
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    await act(async () => el('orchestrator-tavern-innkeeper').click());
    expect(query('orchestrator-peek-drawer')).toBeNull();
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(document.activeElement).toBe(el('chat-composer-input'));
  });

  it('wakes the conversation composer on quiet-scene typing without seeding or sending an order', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    act(() => el('orchestrator-dock-toggle-btn').click());
    vi.useFakeTimers();
    act(() => el('orchestrator-dock-toggle-btn').blur());
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(46000));
    expect(query('orchestrator-ambient-talk-btn')).not.toBeNull();
    const key = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true });
    act(() => document.body.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(true);
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(query('orchestrator-tavern-order-slip')).toBeNull();
    expect(document.activeElement).toBe(el('chat-composer-input'));
    expect((el('chat-composer-input') as HTMLTextAreaElement).value).toBe('');
  });

  it.each(['tavern', 'aquarium'] as const)(
    'closes the %s conversation on outside clicks but preserves portals',
    async view => {
      window.localStorage.setItem(INTRO_SEEN_KEY, '1');
      window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, view);
      await openParent();
      await enterOrchestrate();
      await act(async () => el('chat-thread-empty-host').click());
      expect(query('orchestrator-dock')).not.toBeNull();
      await act(async () => el('thread-portal-control').click());
      expect(query('orchestrator-dock')).not.toBeNull();
      await act(async () => el('chat-composer-input').click());
      expect(query('orchestrator-dock')).not.toBeNull();
      await act(async () => el('chat-header-tools').click());
      expect(query('orchestrator-dock')).toBeNull();
      await act(async () => el('orchestrator-dock-toggle-btn').click());
      await act(async () => document.body.click());
      expect(query('orchestrator-dock')).toBeNull();
      await act(async () => el('orchestrator-dock-toggle-btn').click());
      await act(async () => el(view === 'tavern' ? 'orchestrator-tavern' : 'orchestrator-aquarium').click());
      expect(query('orchestrator-dock')).toBeNull();
      await act(async () => el('orchestrator-dock-toggle-btn').click());
      await act(async () =>
        el(view === 'tavern' ? `orchestrator-tavern-agent-${CHILD.id}` : `orchestrator-fish-${CHILD.id}`).click()
      );
      expect(query('orchestrator-dock')).toBeNull();
      expect(query('orchestrator-peek-drawer')).not.toBeNull();
      await act(async () => el('orchestrator-peek-drawer').click());
      expect(query('orchestrator-peek-drawer')).not.toBeNull();
      await act(async () => el('orchestrator-peek-actions-menu-btn').click());
      await act(async () => el('orchestrator-peek-actions-menu').click());
      expect(query('orchestrator-peek-drawer')).not.toBeNull();
      await act(async () => document.body.click());
      expect(query('orchestrator-peek-drawer')).toBeNull();
      await act(async () =>
        el(view === 'tavern' ? `orchestrator-tavern-agent-${CHILD.id}` : `orchestrator-fish-${CHILD.id}`).click()
      );
      expect(query('orchestrator-peek-drawer')).not.toBeNull();
      await act(async () => el('chat-composer-input').click());
      expect(query('orchestrator-peek-drawer')).toBeNull();
      await act(async () => el('chat-surface-toggle-chat').click());
      await act(async () => el('chat-thread-region').click());
      expect(query('chat-thread-empty-host')).not.toBeNull();
      expect(query('orchestrator-dock-hidden')).toBeNull();
    }
  );

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
    // The fixture agent records no outcome, so it reads as unfinished and the quest as ended.
    expect(el('orchestrator-finale').textContent).toContain('Quest ended');

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

  it("opens a session's own notice on the view it was on, never forcing the stage", async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    listed = [...SESSIONS, CODE];
    await openParent(PARENT_B.title);

    await act(async () => attentionOpen?.({ sessionId: CODE.id, rootId: CODE.id }));
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe(CODE.title);
    expect(query('orchestrator-stage')).toBeNull();
    expect(window.localStorage.getItem(`b4m.orchestrator.surface.${CODE.id}`)).toBeNull();
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

describe('the reply stats rail with the orchestrator', () => {
  let restoreWidth: (() => void) | null = null;

  afterEach(() => {
    restoreWidth?.();
    restoreWidth = null;
  });

  it('draws the rail beside the full-width thread, and keeps the stats under the reply in the dock', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'table');
    reloadReplyStatsPrefs();
    const at = '2026-10-01T00:00:00.000Z';
    parentMessages = [
      { id: 'u1', role: 'user', content: 'A question', createdAt: at },
      {
        id: 'a1',
        role: 'assistant',
        content: 'An answer',
        createdAt: at,
        stats: { totalMs: 4000, modelMs: 4000, toolMs: 0, generation: { tokens: 119, ms: 3000 } },
        usage: { outputTokens: 120 },
      },
    ] as ChatMessage[];
    const width = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1400 } as DOMRect);
    restoreWidth = () => width.mockRestore();
    await openParent();
    expect(el('chat-thread').contains(el('chat-reply-stats-rail'))).toBe(true);
    expect(query('chat-message-cost')).toBeNull();

    await enterOrchestrate();
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(query('chat-reply-stats-rail')).toBeNull();
    expect(el('orchestrator-dock').contains(el('chat-message-cost'))).toBe(true);
    expect(el('chat-message-cost').textContent).toContain('4.0s total');

    act(() => el('chat-surface-toggle-chat').click());
    expect(el('chat-thread').contains(el('chat-reply-stats-rail'))).toBe(true);
  });

  const toggleTitle = async () => {
    const trigger = el('chat-toggle-reply-stats-btn').parentElement!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    const title = document.querySelector('[role="tooltip"]')?.textContent;
    await act(async () => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    return title;
  };

  it.each([
    ['chat, narrow', 600, false, 'Hide reply stats beside the conversation; the window is too narrow for them now'],
    ['chat, wide', 1400, false, 'Hide reply stats'],
    [
      'orchestrate',
      1400,
      true,
      'Hide reply stats beside the conversation; while orchestrating they show under each reply on hover',
    ],
  ])('titles the stats toggle for %s', async (_label, regionWidth, orchestrate, title) => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'table');
    reloadReplyStatsPrefs();
    const width = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: regionWidth } as DOMRect);
    restoreWidth = () => width.mockRestore();
    await openParent();
    if (orchestrate) await enterOrchestrate();

    expect(await toggleTitle()).toBe(title);
  });

  const statsThread = (): ChatMessage[] => {
    const at = '2026-10-01T00:00:00.000Z';
    return [
      { id: 'u1', role: 'user', content: 'A question', createdAt: at },
      {
        id: 'a1',
        role: 'assistant',
        content: 'An answer',
        createdAt: at,
        stats: { totalMs: 4000, modelMs: 4000, toolMs: 0, generation: { tokens: 119, ms: 3000 } },
        usage: { outputTokens: 120 },
      },
    ] as ChatMessage[];
  };

  const wideWindow = () => {
    const width = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1400 } as DOMRect);
    restoreWidth = () => width.mockRestore();
  };

  it.each([
    ['the table', 'table', false],
    ['the tavern', 'tavern', false],
    ['the aquarium', 'aquarium', false],
    ['the office', 'office', false],
    ['Focus mode on the table', 'table', true],
    ['Focus mode on the tavern', 'tavern', true],
  ] as const)('keeps the stats under the reply in the conversation docked over %s', async (_label, view, focus) => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, view);
    if (focus) window.localStorage.setItem('b4m.orchestrator.focus', '1');
    reloadReplyStatsPrefs();
    parentMessages = statsThread();
    wideWindow();
    await openParent();
    expect(el('chat-thread').contains(el('chat-reply-stats-rail'))).toBe(true);

    await enterOrchestrate();
    expect(query('orchestrator-focus-panel') !== null).toBe(focus);
    expect(query('chat-reply-stats-rail')).toBeNull();
    expect(el('orchestrator-dock').contains(el('chat-message-cost'))).toBe(true);
    expect(el('chat-message-cost').textContent).toContain('4.0s total');
  });

  it("keeps the stats under the reply in an agent's details over a scene", async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'tavern');
    reloadReplyStatsPrefs();
    childMessages = statsThread();
    wideWindow();
    await openParent();
    await enterOrchestrate();
    await act(async () => el(`orchestrator-tavern-agent-${CHILD.id}`).click());
    await act(async () => undefined);

    const drawer = el('orchestrator-peek-drawer');
    expect(drawer.querySelector('[data-testid="chat-message-cost"]')?.textContent).toContain('4.0s total');
    expect(query('chat-reply-stats-rail')).toBeNull();
  });
});
