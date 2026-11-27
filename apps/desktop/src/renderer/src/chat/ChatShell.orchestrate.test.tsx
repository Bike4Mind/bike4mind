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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { TAVERN_SCENE } from './orchestrator/tavern/tavernScene';

const DOOR_POINT = TAVERN_SCENE.map.door;
import { reloadReplyStatsPrefs } from './replyStatsPrefs';
import type { HostBridgeApi } from '@shared/hostBridge';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Screens and panels this test never opens, each with its own IPC to stub otherwise.
vi.mock('./CustomizePanel', () => ({ CustomizeScreen: () => null, useCustomizeAttention: () => undefined }));
vi.mock('./BrowserPane', () => ({
  BrowserPane: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="test-browser-pane" data-session-id={sessionId} />
  ),
}));
vi.mock('./ArtifactLibraryPanel', () => ({ ArtifactLibraryPanel: () => null }));
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
      host: chatBackedHostBridge(),
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
        inspectProject: async (directory: string) => ({
          directory,
          isRepository: false,
          currentBranch: 'main',
          branches: [],
        }),
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

const query = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const el = (testId: string) => {
  const found = query(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

async function clickSessionRow(title: string) {
  const row = Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]')).find(
    candidate => candidate.textContent?.includes(title)
  );
  if (!row) throw new Error(`no row ${title}`);
  await act(async () => row.click());
  await act(async () => undefined);
}

const highlightedTitle = () =>
  document.body
    .querySelector('[data-testid="chat-session-item"][aria-current="true"]')
    ?.querySelector('[data-testid="chat-session-title-text"]')?.textContent;

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
  if (mode === 'code') await act(async () => el('place-rail-code-btn').click());
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
    await act(async () =>
      el('orchestrator-pr-indicator').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    );
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
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem('b4m.orchestrator.view.other-scope', 'board');
    window.localStorage.setItem('b4m.orchestrator.surface.other-scope', 'orchestrate');
    await openParent();
    // Stored prefs for sessions outside the current listing are never dropped.
    expect(window.localStorage.getItem('b4m.orchestrator.view.other-scope')).toBe('board');
    expect(window.localStorage.getItem('b4m.orchestrator.surface.other-scope')).toBe('orchestrate');
    expect(el('chat-orchestrate-count').textContent).toBe('1');
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-thread-empty-host')).not.toBeNull();
    await enterOrchestrate();
    expect(query('orchestrator-stage')).not.toBeNull();
    // The composer's Orchestrate pill is a Code-mode control.
    expect(query('composer-orchestrate-toggle')).toBeNull();
  });

  it('keeps the active Office scene and parent conversation when the sidebar selects an agent repeatedly', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'office');
    await openParent();
    await enterOrchestrate();
    const stage = el('orchestrator-stage');
    const office = el('orchestrator-office');
    const thread = el('orchestrator-dock').querySelector('[data-testid="chat-thread-empty-host"]');
    const layout = window.localStorage.getItem(`b4m.orchestrator.layout.${PARENT.id}`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await clickSessionRow(CHILD.title);
      expect(el('orchestrator-stage')).toBe(stage);
      expect(el('orchestrator-office')).toBe(office);
      expect(el('orchestrator-dock-hidden').querySelector('[data-testid="chat-thread-empty-host"]')).toBe(thread);
      expect(el('chat-session-title').textContent).toBe(PARENT.title);
      expect(highlightedTitle()).toBe(CHILD.title);
      expect(el('orchestrator-peek-drawer').textContent).toContain(CHILD.title);
      await clickSessionRow(CHILD.title);
      expect(el('orchestrator-peek-drawer').textContent).toContain(CHILD.title);
      expect(window.localStorage.getItem(`b4m.orchestrator.view.${PARENT.id}`)).toBe('office');
      expect(window.localStorage.getItem(`b4m.orchestrator.layout.${PARENT.id}`)).toBe(layout);
      await act(async () => el('orchestrator-peek-close-btn').click());
      expect(query('orchestrator-peek-drawer')).toBeNull();
      expect(highlightedTitle()).toBe(PARENT.title);
    }
  });

  it('keeps split panes and their sizes while sidebar and scene selections share the drawer', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const layout = JSON.stringify({
      split: 'row',
      panes: [
        { view: 'office', size: 0.65 },
        { view: 'table', size: 0.35 },
      ],
    });
    window.localStorage.setItem(`b4m.orchestrator.layout.${PARENT.id}`, layout);
    await openParent();
    await enterOrchestrate();
    const office = el('orchestrator-office');
    const tableRow = el(`orchestrator-table-row-${CHILD.id}`);
    await clickSessionRow(CHILD.title);
    expect(highlightedTitle()).toBe(CHILD.title);
    expect(el('orchestrator-peek-drawer').textContent).toContain(CHILD.title);
    await act(async () => el('orchestrator-peek-close-btn').click());
    await act(async () => tableRow.click());
    expect(highlightedTitle()).toBe(CHILD.title);
    expect(el('orchestrator-office')).toBe(office);
    expect(el(`orchestrator-table-row-${CHILD.id}`)).toBe(tableRow);
    expect(window.localStorage.getItem(`b4m.orchestrator.layout.${PARENT.id}`)).toBe(layout);
  });

  // One scene stands for all: each view reports selection through the same stage callback.
  it('syncs scene selection to the sidebar and clears it with Escape', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'tavern');
    await openParent();
    await enterOrchestrate();
    const stage = el('orchestrator-stage');
    await act(async () => el(`orchestrator-tavern-agent-${CHILD.id}`).click());
    expect(highlightedTitle()).toBe(CHILD.title);
    expect(el('chat-session-title').textContent).toBe(PARENT.title);
    await act(async () =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    );
    expect(highlightedTitle()).toBe(PARENT.title);
    expect(query('orchestrator-peek-drawer')).toBeNull();
    expect(el('orchestrator-stage')).toBe(stage);
  });

  it('focuses a nested descendant through the sidebar keyboard shortcut without replacing the viewer', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'office');
    const nested = {
      ...CHILD,
      id: 'nested-agent',
      title: 'Nested agent',
      origin: { parentSessionId: CHILD.id, seedPrompt: 'nested work' },
    } as ChatSessionSummary;
    listed = [...SESSIONS, nested];
    await openParent();
    await enterOrchestrate();
    await clickSessionRow(CHILD.title);
    const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="chat-session-item"]'));
    const index = rows.findIndex(row => row.textContent?.includes(nested.title));
    expect(index).toBeGreaterThanOrEqual(0);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: String(index + 1),
          code: `Digit${index + 1}`,
          // The session chord off macOS; jsdom does not report a Mac.
          altKey: true,
          bubbles: true,
        })
      )
    );
    expect(el('chat-session-title').textContent).toBe(PARENT.title);
    expect(query('orchestrator-office')).not.toBeNull();
    expect(el('orchestrator-peek-drawer').textContent).toContain(nested.title);
    expect(highlightedTitle()).toBe(nested.title);
    await act(async () => el('orchestrator-peek-open-btn').click());
    expect(el('chat-session-title').textContent).toBe(nested.title);
    expect(query('orchestrator-stage')).toBeNull();
  });

  it('navigates normally to another roster or root while Show agents is visible', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    await clickSessionRow(CHILD_B.title);
    expect(el('chat-session-title').textContent).toBe(CHILD_B.title);
    expect(query('orchestrator-stage')).toBeNull();
    await clickSessionRow(PARENT.title);
    expect(query('orchestrator-stage')).not.toBeNull();
    await clickSessionRow(PARENT_B.title);
    expect(el('chat-session-title').textContent).toBe(PARENT_B.title);
    expect(query('orchestrator-stage')).toBeNull();
  });

  it('navigates to descendants normally after Show agents is closed, and from another screen', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    await act(async () => el('chat-surface-toggle-chat').click());
    await clickSessionRow(CHILD.title);
    expect(el('chat-session-title').textContent).toBe(CHILD.title);
    expect(query('orchestrator-stage')).toBeNull();

    // Even when the parent has a remembered agents surface.
    await clickSessionRow(PARENT.title);
    await enterOrchestrate();
    await act(async () => el('chat-artifacts-btn').click());
    await clickSessionRow(CHILD.title);
    expect(el('chat-session-title').textContent).toBe(CHILD.title);
    expect(query('orchestrator-stage')).toBeNull();
  });

  it.each(['aquarium'] as const)(
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
      const scene = el('orchestrator-aquarium');
      expect(getComputedStyle(scene).getPropertyValue('anchor-name')).toBe('--orchestrator-scene');
      const agent = el(`orchestrator-aquarium-agent-${CHILD.id}`);
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

  it('docks the conversation beside the stage, toggles and closes the dock, and keeps one thread mounted', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    const mountsBefore = threadMounts.count;
    const request = vi.spyOn((window as unknown as { b4m: { host: HostBridgeApi } }).b4m.host, 'request');
    const subscribed = () =>
      request.mock.calls.filter(([, method]) => method === 'session/subscribe').map(([, , params]) => params);
    await enterOrchestrate();
    // Agent activity is subscribed to only while orchestrating.
    expect(subscribed().length).toBeGreaterThan(0);
    expect(query('orchestrator-stage')).not.toBeNull();
    expect(el('orchestrator-dock').querySelector('[data-testid="chat-thread-empty-host"]')).not.toBeNull();

    act(() => el('orchestrator-dock-toggle-btn').click());
    expect(query('orchestrator-dock')).toBeNull();
    expect(query('orchestrator-stage')).not.toBeNull();
    // Hidden, not unmounted.
    expect(el('orchestrator-dock-hidden').querySelector('[data-testid="chat-thread-empty-host"]')).not.toBeNull();

    act(() => el('orchestrator-dock-toggle-btn').click());
    // The dock's own close button hands focus to the header's dock toggle.
    act(() => el('orchestrator-dock-close-btn').click());
    expect(query('orchestrator-dock')).toBeNull();
    expect(document.activeElement).toBe(el('orchestrator-dock-toggle-btn'));

    const unsubscribed = () => request.mock.calls.filter(([, method]) => method === 'session/unsubscribe').length;
    const unsubscribedBefore = unsubscribed();
    // Leaving orchestrate releases the agents' activity subscriptions.
    await act(async () => el('chat-surface-toggle-chat').click());
    expect(unsubscribed()).toBeGreaterThan(unsubscribedBefore);
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('chat-thread-empty-host')).not.toBeNull();
    await enterOrchestrate();
    act(() => el('chat-surface-toggle-chat').click());
    expect(threadMounts.count).toBe(mountsBefore);
  });

  it('fills the window with the stage from the header button or F, and restores the layout on Escape or Exit', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    const hidden = (testId: string) => getComputedStyle(el(testId)).display === 'none';
    const expectNormalLayout = () => {
      expect(hidden('chat-shell-navigation')).toBe(false);
      expect(hidden('chat-conversation-header')).toBe(false);
      expect(hidden('chat-composer-region')).toBe(false);
      expect(query('orchestrator-dock')).not.toBeNull();
      expect(query('orchestrator-fill-window-btn')).not.toBeNull();
      expect(query('orchestrator-fill-exit-btn')).toBeNull();
    };
    const expectFilled = () => {
      expect(hidden('chat-shell-navigation')).toBe(true);
      expect(hidden('chat-conversation-header')).toBe(true);
      expect(hidden('chat-composer-region')).toBe(true);
      expect(query('orchestrator-dock')).toBeNull();
      expect(query('orchestrator-stage')).not.toBeNull();
      expect(el('orchestrator-fill-view-name').textContent).toBe('Tavern');
      expect(query('orchestrator-dock-toggle-btn')).toBeNull();
    };
    const press = (key: string, target: EventTarget = document.body) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    expectNormalLayout();

    act(() => el('orchestrator-fill-window-btn').click());
    expectFilled();
    // The composer is hidden, not unmounted, so its draft survives.
    expect(query('chat-composer-input')).not.toBeNull();
    act(() => el('orchestrator-fill-exit-btn').click());
    expectNormalLayout();

    // A key typed into the composer is the composer's.
    press('f', el('chat-composer-input'));
    expectNormalLayout();

    press('f');
    expectFilled();
    press('Escape');
    expectNormalLayout();

    // The dock counts as hidden while filled, so a scene click cannot close it behind the user's back.
    press('f');
    await act(async () => el(`orchestrator-tavern-agent-${CHILD.id}`).click());
    act(() => el('orchestrator-fill-exit-btn').click());
    expect(query('orchestrator-dock')).not.toBeNull();

    // Opening the conversation from the scene leaves fill window rather than opening it out of sight.
    press('f');
    await act(async () => el('orchestrator-tavern-host').click());
    expectNormalLayout();
    expect(document.activeElement).toBe(el('chat-composer-input'));

    // Leaving the Agent view drops it, so coming back opens the normal layout.
    press('f');
    act(() => el('chat-surface-toggle-chat').click());
    expect(hidden('chat-shell-navigation')).toBe(false);
    await enterOrchestrate();
    expect(hidden('chat-shell-navigation')).toBe(false);
    expect(hidden('chat-composer-region')).toBe(false);
    expect(query('orchestrator-fill-exit-btn')).toBeNull();

    // The Agents place has no stage and so no Exit: going there leaves full window, for good.
    const sessionPlace = document.querySelector('[data-testid^="place-rail-"][aria-current="page"]');
    if (!(sessionPlace instanceof HTMLElement)) throw new Error('no current place on the rail');
    press('f');
    act(() => el('place-rail-agents-btn').click());
    expect(query('agents-place')).not.toBeNull();
    expect(hidden('chat-shell-navigation')).toBe(false);
    await act(async () => sessionPlace.click());
    expect(query('orchestrator-fill-exit-btn')).toBeNull();
    expect(hidden('chat-shell-navigation')).toBe(false);
  });

  it('keeps the ambient settle off while the window is filled', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    act(() => el('orchestrator-fill-window-btn').click());
    vi.useFakeTimers();
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(46000));
    expect(query('orchestrator-ambient-talk-btn')).toBeNull();
    expect(query('orchestrator-fill-exit-btn')).not.toBeNull();
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

  it('turning Orchestrate on exposes an empty agents scene while starting in conversation', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    listed = [...SESSIONS, CODE];
    await openParent(CODE.title, 'code');
    expect(query('chat-surface-toggle')).toBeNull();
    expect(query('orchestrate-example-quests')).toBeNull();

    await act(async () => el('composer-orchestrate-toggle').click());
    await act(async () => el('orchestrate-budget-start-btn').click());
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
    await act(async () => el('orchestrate-budget-start-btn').click());
    expect(el('chat-notice').textContent).toContain('Could not change Orchestrate. disk full');
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('false');

    setSessionOrchestrate.mockResolvedValueOnce(null);
    await act(async () => el('composer-orchestrate-toggle').click());
    await act(async () => el('orchestrate-budget-start-btn').click());
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

  it('offers orchestrate controls below the spawn depth cap, but not at it or on a model with no tools, even with the flag on', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    const shallow = {
      ...CODE,
      id: 'code-shallow',
      title: 'Shallow agent',
      origin: { parentSessionId: CODE.id, depth: 1, seedPrompt: 'shallow' },
    } as ChatSessionSummary;
    const deep = {
      ...CODE,
      id: 'code-deep',
      title: 'Deep agent',
      orchestrate: true,
      origin: { parentSessionId: CODE.id, depth: 2, seedPrompt: 'deep' },
    } as ChatSessionSummary;
    window.localStorage.setItem(`b4m.orchestrator.surface.${deep.id}`, 'orchestrate');
    const noTools = {
      ...CODE,
      id: 'code-no-tools',
      title: 'No tools thread',
      model: 'no-tools',
      orchestrate: true,
    } as ChatSessionSummary;
    window.localStorage.setItem(`b4m.orchestrator.surface.${noTools.id}`, 'orchestrate');
    catalogModels = [
      { id: 'test-model', name: 'Test Model', supportsTools: true },
      { id: 'no-tools', name: 'No tools', supportsTools: false } as ChatModelOption,
    ];
    listed = [...SESSIONS, CODE, shallow, deep, noTools];
    await openParent(deep.title, 'code');
    expect(el('chat-session-title').textContent).toBe(deep.title);
    expect(query('chat-surface-toggle-orchestrate')).toBeNull();
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('composer-orchestrate-toggle')).toBeNull();

    await clickSessionRow(shallow.title);
    expect(el('chat-session-title').textContent).toBe(shallow.title);
    expect(query('composer-orchestrate-toggle')).not.toBeNull();
    // It has spawned nothing yet, so there is no agents view to switch to.
    expect(query('chat-surface-toggle')).toBeNull();

    await clickSessionRow(noTools.title);
    expect(el('chat-session-title').textContent).toBe(noTools.title);
    expect(query('chat-surface-toggle-orchestrate')).toBeNull();
    expect(query('orchestrator-stage')).toBeNull();
    expect(query('composer-orchestrate-toggle')).toBeNull();
  });

  it('toggles the conversation directly from the Innkeeper and brings it forward over an agent peek', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    await openParent();
    await enterOrchestrate();
    act(() => el('orchestrator-dock-toggle-btn').click());
    expect(query('orchestrator-dock')).toBeNull();

    await act(async () => el('orchestrator-tavern-host').click());
    expect(query('orchestrator-tavern-order-slip')).toBeNull();
    expect(query('orchestrator-dock')).not.toBeNull();
    expect(document.activeElement).toBe(el('chat-composer-input'));
    await act(async () => el('orchestrator-tavern-host').click());
    expect(query('orchestrator-dock')).toBeNull();
    await act(async () => el('orchestrator-tavern-host').click());
    await act(async () => el(`orchestrator-tavern-agent-${CHILD.id}`).click());
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    await act(async () => el('orchestrator-tavern-host').click());
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

  it.each(['tavern'] as const)('closes the %s conversation on outside clicks but preserves portals', async view => {
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
    await act(async () => el('orchestrator-tavern').click());
    expect(query('orchestrator-dock')).toBeNull();
    await act(async () => el('orchestrator-dock-toggle-btn').click());
    await act(async () => el(`orchestrator-tavern-agent-${CHILD.id}`).click());
    expect(query('orchestrator-dock')).toBeNull();
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    await act(async () => el('orchestrator-peek-drawer').click());
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    await act(async () => el('orchestrator-peek-actions-menu').click());
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    await act(async () => document.body.click());
    expect(query('orchestrator-peek-drawer')).toBeNull();
    await act(async () => el(`orchestrator-tavern-agent-${CHILD.id}`).click());
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    await act(async () => el('chat-composer-input').click());
    expect(query('orchestrator-peek-drawer')).toBeNull();
    await act(async () => el('chat-surface-toggle-chat').click());
    await act(async () => el('chat-thread-region').click());
    expect(query('chat-thread-empty-host')).not.toBeNull();
    expect(query('orchestrator-dock-hidden')).toBeNull();
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

  it('routes a clicked notice: ignores a deleted session, keeps a root on its view, and peeks an agent', async () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    window.localStorage.setItem(`b4m.orchestrator.view.${PARENT.id}`, 'table');
    listed = [...SESSIONS, CODE];
    await openParent(PARENT_B.title);

    await act(async () => attentionOpen?.({ sessionId: 'deleted-agent', rootId: 'deleted-parent' }));
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe(PARENT_B.title);
    expect(window.localStorage.getItem('b4m.orchestrator.surface.deleted-parent')).toBeNull();

    // A session's own notice opens on the view it was on, never forcing the stage.
    await act(async () => attentionOpen?.({ sessionId: CODE.id, rootId: CODE.id }));
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe(CODE.title);
    expect(query('orchestrator-stage')).toBeNull();
    expect(window.localStorage.getItem(`b4m.orchestrator.surface.${CODE.id}`)).toBeNull();

    // An agent's notice selects its parent, orchestrates, and peeks the agent.
    await act(async () => attentionOpen?.({ sessionId: CHILD.id, rootId: PARENT.id }));
    await act(async () => undefined);
    expect(el('chat-session-title').textContent).toBe(PARENT.title);
    expect(query('orchestrator-stage')).not.toBeNull();
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
  });
});

describe('the reply stats rail with the orchestrator', () => {
  let restoreWidth: (() => void) | null = null;

  afterEach(() => {
    restoreWidth?.();
    restoreWidth = null;
  });

  const toggleTitle = async () => {
    const trigger = el('chat-toggle-reply-stats-btn').parentElement!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
    });
    const title = document.body.querySelector('[role="tooltip"]')?.textContent;
    await act(async () => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    return title;
  };

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
    // The other titles are replyStatsToggleTitle's own tests; this proves the orchestrator state reaches it.
    expect(await toggleTitle()).toBe(
      'Hide reply stats beside the conversation; while orchestrating they show under each reply on hover'
    );

    act(() => el('chat-surface-toggle-chat').click());
    expect(el('chat-thread').contains(el('chat-reply-stats-rail'))).toBe(true);
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

  // The rail hides for any shown orchestrator whatever the view; the tavern stands in for the scene
  // overlays, and the table for the side dock in the first test above.
  it.each([['Focus mode on the tavern', 'tavern', true]] as const)(
    'keeps the stats under the reply in the conversation docked over %s',
    async (_label, view, focus) => {
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
    }
  );

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
