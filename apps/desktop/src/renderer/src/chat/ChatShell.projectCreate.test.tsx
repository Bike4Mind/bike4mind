// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { setWorktreeByDefault } from './worktreeDefault';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const PROJECT = {
  directory: '/repo',
  name: 'repo',
  branch: 'main',
  workspace: false,
  workingDirectory: '/repo',
};

const FIRST: ChatSessionSummary = {
  id: 'code-1',
  title: 'First',
  mode: 'code',
  model: 'test-model',
  project: PROJECT,
  messageCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as ChatSessionSummary;

const SECOND: ChatSessionSummary = { ...FIRST, id: 'code-2', title: 'Second' };
const FRESH: ChatSessionSummary = { ...FIRST, id: 'code-3', title: 'Fresh thread' };

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
let createCodeSession = vi.fn<(request?: unknown) => Promise<unknown>>();
let inspectProject = vi.fn<(directory: string) => Promise<unknown>>();
let created: ChatSessionSummary | null = null;
let supportsTools = true;
const setSessionOrchestrate = vi.fn();
const sendMessage = vi.fn();

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
  // Opens on a Code session, so the sidebar draws the project group and its "+".
  window.localStorage.setItem('b4m.chat.lastSession', JSON.stringify({ id: FIRST.id, mode: 'code' }));
  created = null;
  supportsTools = true;
  setSessionOrchestrate.mockReset().mockImplementation(async (id: string, on: boolean) => {
    if (!created || created.id !== id) return null;
    created = { ...created, orchestrate: on };
    return created;
  });
  sendMessage.mockReset().mockResolvedValue({ ok: true, messageId: 'first-message' });
  createCodeSession = vi.fn(async () => {
    created = FRESH;
    return { ok: true, session: FRESH };
  });
  inspectProject = vi.fn(async () => ({
    directory: PROJECT.directory,
    name: PROJECT.name,
    isRepository: true,
    branches: ['main'],
    currentBranch: 'main',
  }));
  (window as unknown as { b4m: unknown }).b4m = new Proxy(
    {
      chat: quietBridge({
        listSessions: async () => (created ? [FIRST, SECOND, created] : [FIRST, SECOND]),
        getSession: async (id: string) =>
          ({ ...(id === FRESH.id ? (created ?? FRESH) : FIRST), messages: [] }) as unknown as ChatSession,
        getQueuedMessages: async () => [],
        getSessionStatuses: async () => [],
        listModels: async () => ({ models: [{ id: 'test-model', name: 'Test Model', supportsTools }] }),
        defaultsForNewSession: async () => ({ model: 'test-model', approvalMode: 'auto', reasoningEffort: 'default' }),
        setSessionOrchestrate,
        sendMessage,
        // The bridge's `[]` default is truthy, so the changes bar would render it as a reading.
        workspaceChanges: async () => null,
        inspectProject,
        createCodeSession,
      }),
      sidebar: quietBridge({ getSections: async () => ({ sections: [], assignments: {} }) }),
      getAppInfo: async () => ({ homeDirectory: '/home/user' }),
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
  setWorktreeByDefault(false);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

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
  await act(async () => undefined);
}

async function clickNewInProject() {
  await act(async () => el('project-new-btn').click());
  await act(async () => undefined);
}

describe("starting a new session from a project group's header", () => {
  it('starts it in a worktree when the user wants that by default', async () => {
    setWorktreeByDefault(true);
    await mount();

    await clickNewInProject();

    expect(inspectProject).toHaveBeenCalledWith(PROJECT.directory);
    expect(createCodeSession).not.toHaveBeenCalled();
    expect(el('chat-code-workspace-setup').textContent).toContain(PROJECT.name);
  });

  it('opens a project draft without persisting when the preference is off', async () => {
    await mount();

    await clickNewInProject();

    expect(createCodeSession).not.toHaveBeenCalled();
    expect(el('chat-code-workspace-setup').textContent).toContain(PROJECT.name);
  });
  it('enables orchestration on a bound Code draft and saves it before the first send', async () => {
    await mount();
    await clickNewInProject();
    expect(createCodeSession).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-testid="chat-session-item"]')).toHaveLength(2);
    await act(async () => el('composer-orchestrate-toggle').click());
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(setSessionOrchestrate).not.toHaveBeenCalled();
    await act(async () => el('orchestrator-example-quest-1').click());
    await act(async () => el('chat-send-btn').click());
    expect(createCodeSession).toHaveBeenCalledOnce();
    expect(setSessionOrchestrate).toHaveBeenCalledExactlyOnceWith(FRESH.id, true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(setSessionOrchestrate.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
  });

  it('keeps orchestration unavailable on a draft whose model cannot use tools', async () => {
    supportsTools = false;
    await mount();
    await clickNewInProject();
    expect(document.querySelector('[data-testid="composer-orchestrate-toggle"]')).toBeNull();
    expect(createCodeSession).not.toHaveBeenCalled();
  });
});
